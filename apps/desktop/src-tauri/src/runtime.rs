// Manages the bundled DeepSeek Harness (dsh) sidecar so it never interferes
// with any dsh the user already has: it runs the bundled CLI, on a *dedicated
// free port*, with an *app-private* DSH_HOME, and is killed on app exit.
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};


#[derive(Default)]
struct RuntimeLifecycle {
    child: Option<std::process::Child>,
    /// The internal gateway's URL — what the frontend connects to.
    url: Option<String>,
    port: Option<u16>,
    /// The raw dsh sidecar URL (`http://127.0.0.1:<sidecar-port>`), which the
    /// gateway proxies to. Distinct from `url` (the gateway URL): `sidecar_url`
    /// must keep pointing at the sidecar so the gateway's `/api` + WebSocket
    /// proxies don't dial themselves.
    sidecar_url: Option<String>,
    /// Token of the internal same-origin gateway the desktop shell talks to
    /// (see gateway::start_internal). The WebView cannot reach the loopback
    /// sidecar cross-origin, so every request carries this token instead.
    gateway_token: Option<String>,
}

/// One lock owns every sidecar lifecycle field. Keeping child/url/port in
/// separate mutexes allowed two concurrent `start_runtime` calls to both see
/// "stopped", spawn on the same port, and overwrite each other's child handle.
#[derive(Default)]
pub struct RuntimeState {
    lifecycle: Mutex<RuntimeLifecycle>,
}

/// App-private runtime root, e.g. ~/Library/Application Support/com.sculab.deeplab/runtime
pub(crate) fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime"))
}

/// The running sidecar's base URL (`http://127.0.0.1:<port>`), or None when the
/// runtime is not started yet. The gateway proxies agent calls here.
pub(crate) fn sidecar_url(state: &RuntimeState) -> Option<String> {
    state.lifecycle.lock().unwrap().sidecar_url.clone()
}

pub(crate) fn xdg_config_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("xdg-config"))
}

/// The dsh sidecar's private home (`DSH_HOME`) — profiles, skills, and the
/// global memory file all live here, isolated from the user's own ~/.dsh.
pub(crate) fn dsh_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("dsh-home"))
}

/// The sidecar's XDG_DATA_HOME.
pub(crate) fn xdg_data_home(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("xdg-data"))
}

/// File recording the user's chosen active workspace folder (absolute path).
fn active_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("active-workspace.txt"))
}

/// File recording the user's chosen BASE folder — it contains the managed
/// `projects/` and `sessions/` collections (Settings → Workspace).
fn base_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("base-workspace.txt"))
}

pub(crate) const PROJECTS_DIR_NAME: &str = "projects";
pub(crate) const SESSIONS_DIR_NAME: &str = "sessions";

/// Keep the user-visible workspace root predictable:
///
/// ```text
/// DeepLab/
///   projects/
///   sessions/
///   .deeplab/
/// ```
///
/// Existing root-level workspaces are left where they are and remain readable.
/// Moving them would invalidate absolute session directories stored by dsh.
fn ensure_base_layout(dir: PathBuf) -> Result<PathBuf, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for child in [PROJECTS_DIR_NAME, SESSIONS_DIR_NAME] {
        std::fs::create_dir_all(dir.join(child)).map_err(|e| e.to_string())?;
    }
    Ok(dir)
}

pub(crate) fn projects_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_workspace_dir(app)?.join(PROJECTS_DIR_NAME))
}

pub(crate) fn sessions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(base_workspace_dir(app)?.join(SESSIONS_DIR_NAME))
}

/// A workspace path read back from disk. Installs predating #76 wrote the Windows
/// `\\?\` verbatim form here, which then flowed to the UI and could never match a
/// session's `directory`; unwrapping on read repairs them without a re-pick. The
/// transform is Windows-only — elsewhere `\` is a legal filename character.
fn persisted_path(raw: &str) -> String {
    #[cfg(target_os = "windows")]
    return crate::artifact_file::strip_windows_verbatim(raw);
    #[cfg(not(target_os = "windows"))]
    return raw.to_owned();
}

/// The active workspace folder dsh / the kernel / previews / provenance all
/// operate in. Defaults to the base folder (`~/Documents/DeepLab`) until the
/// user opens or creates another one; the choice persists across restarts.
pub fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = active_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = resolve_workspace_path(app, &PathBuf::from(s.trim()));
            if dir.is_dir() {
                return ensure_base_layout(dir);
            }
        }
    }
    base_workspace_dir(app)
}

/// Resolve a workspace path that may point under a legacy base folder
/// (`~/Documents/OpenLab/…`, `~/Documents/OpenScience/…`):
///
/// - When the legacy path **still exists**, keep it — the old app's data was
///   never moved (the base-folder migration only renames the old names when
///   `DeepLab` does not exist yet), so the session's files live there and must
///   stay reachable.
/// - When it does **not** exist, map it to the `OpenLab` equivalent so the old
///   folder is never resurrected (the pre-fix `set_workspace` re-created
///   `~/Documents/OpenLab` every time such a session was opened or moved
///   into a project).
pub fn resolve_workspace_path(app: &AppHandle, path: &Path) -> PathBuf {
    resolve_legacy_decision(&normalize_legacy_base(app, path), path)
}

/// Pure: keep the original legacy path when it still holds data, else take the
/// rewritten (`OpenLab`) one.
fn resolve_legacy_decision(rewritten: &Path, original: &Path) -> PathBuf {
    if rewritten != original && original.exists() {
        original.to_path_buf()
    } else {
        rewritten.to_path_buf()
    }
}

/// Rewrite a path that lives under a legacy base-folder name (`OpenScience`,
/// `Open Science`) to its `OpenLab` equivalent; other paths pass through
/// unchanged. Pure — existence is judged by `resolve_workspace_path`.
pub fn normalize_legacy_base(app: &AppHandle, path: &Path) -> PathBuf {
    let docs = match app.path().document_dir() {
        Ok(d) => d,
        Err(_) => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents"),
    };
    rewrite_legacy_base(&docs, path)
}

/// Pure: rewrite `path` under a legacy base folder inside `docs` to its
/// `OpenLab` equivalent; other paths pass through unchanged.
fn rewrite_legacy_base(docs: &Path, path: &Path) -> PathBuf {
    let current = docs.join("DeepLab");
    for legacy in ["OpenLab", "OpenScience", "Open Science"] {
        if let Ok(rel) = path.strip_prefix(docs.join(legacy)) {
            return current.join(rel);
        }
    }
    path.to_path_buf()
}

/// The app's private metadata folder inside a workspace (`<root>/.deeplab`),
/// home to `project.json`, provenance, runs, compute machines and env locks.
pub const META_DIR: &str = ".deeplab";

/// Resolve `<root>/<META_DIR>`, migrating the legacy `.openlab` name on
/// first access (a rename in place, so workspaces created by Open Lab keep
/// their provenance/runs/compute data). Non-mutating paths that must still
/// read an unmigrated workspace fall back per file.
pub fn app_meta_dir(root: &Path) -> PathBuf {
    let new = root.join(META_DIR);
    let legacy = root.join(".openlab");
    if !new.exists() && legacy.exists() {
        let _ = std::fs::rename(&legacy, &new);
    }
    new
}

/// The workspace root containing the `projects/` and `sessions/` collections.
/// A folder the user picked in Settings wins; the default is `~/Documents/DeepLab`
/// (no space — the agent runs shell commands against this path, and unquoted
/// spaces break them), falling back to `$HOME/Documents`.
pub fn base_workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = base_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = PathBuf::from(persisted_path(s.trim()));
            if dir.is_dir() {
                return Ok(dir);
            }
        }
    }
    let docs = match app.path().document_dir() {
        Ok(d) => d,
        Err(_) => {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map_err(|_| "could not resolve a documents directory".to_string())?;
            PathBuf::from(home).join("Documents")
        }
    };
    let dir = docs.join("DeepLab");

    // One-time migrations, oldest name last. A failed rename (e.g. cross-volume)
    // keeps the existing location rather than splitting the user's files.
    if !dir.exists() {
        for old in [
            docs.join("OpenScience"),
            docs.join("Open Science"),
            runtime_root(app)?.join("workspace"),
        ] {
            if old.is_dir() {
                if std::fs::rename(&old, &dir).is_ok() {
                    break;
                }
                return ensure_base_layout(old);
            }
        }
    }
    ensure_base_layout(dir)
}

/// The config file to edit in place: the server may have rewritten the config
/// as dsh.jsonc — prefer whichever exists, fall back to dsh.json.
pub(crate) fn effective_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = xdg_config_home(app)?.join("dsh");
    Ok(["dsh.jsonc", "dsh.json"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .unwrap_or_else(|| dir.join("dsh.json")))
}

/// Copy the user's dsh CLI login into the app-private data dir, EXPLICITLY
/// Whether the bundled runtime's credential store (its auth.json) has an entry
/// for this provider. The sidecar writes the token there the moment a browser
/// login completes, so the UI can fall back on it when the pending OAuth
/// callback request is lost (loopback port collision, proxy) — issue #17.
#[tauri::command(async)]
pub fn provider_auth_exists(app: AppHandle, provider_id: String) -> Result<bool, String> {
    let path = runtime_root(&app)?
        .join("xdg-data")
        .join("dsh")
        .join("auth.json");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(false); // no store yet — no logins
    };
    Ok(auth_has_provider(&text, &provider_id))
}

fn auth_has_provider(text: &str, provider_id: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .is_some_and(|auth| auth.get(provider_id).is_some())
}

/// Deploy the bundled skill packs (Tauri resources) into the app-private dsh
/// home's global skills dir (`<dsh-home>/skills/`), which dsh scans regardless
/// of project detection: `skills/` is the external ai4s-skills pack,
/// `skills-office/` Anthropic's document skills (docx/pdf/pptx/xlsx),
/// `skills-agent-browser/` the version-matched official agent-browser skill,
/// `skills-core/` the first-party skills from `runtime/skills/core`. The
/// workspace's own `.dsh/skills/` stays reserved for skills the user
/// installs. Runs before every sidecar start so app upgrades refresh the packs.
fn deploy_bundled_skills(app: &AppHandle, dsh_home: &Path) {
    let dst = dsh_home.join("skills");
    let mut bundled: std::collections::HashSet<std::ffi::OsString> = std::collections::HashSet::new();
    let mut all_ok = true;
    for resource in [
        "skills",
        "skills-office",
        "skills-agent-browser",
        "skills-core",
    ] {
        let src = match app
            .path()
            .resolve(resource, tauri::path::BaseDirectory::Resource)
        {
            Ok(p) if p.is_dir() => p,
            _ => {
                all_ok = false; // dev run without `fetch-skills.sh` — nothing to deploy
                continue;
            }
        };
        match sync_skill_pack(&src, &dst) {
            Ok(names) => bundled.extend(names),
            Err(e) => {
                all_ok = false;
                eprintln!("failed to deploy bundled skills ({resource}): {e}");
            }
        }
    }
    // The global skills dir is exclusively app-managed (the user's own skills
    // live in the workspace's `.dsh/skills/`), so any skill dir not in the
    // freshly-bundled set is a stale leftover — e.g. one renamed across an app
    // upgrade (`hpc-slurm` → `remote-compute`) — and must be removed so the
    // obsolete duplicate can't shadow or confuse the agent. Prune ONLY when all
    // packs deployed cleanly: a partial deploy would make `bundled`
    // incomplete and wrongly delete valid skills.
    if all_ok {
        prune_stale_skills(&dst, &bundled);
    }
}

/// The app-owned global memory file listed in every session's `instructions`.
pub(crate) fn global_memory_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    dsh_home(app).ok().map(|h| h.join("MEMORY.md"))
}

/// Code-enforced foundational memory: ensure the global MEMORY.md exists with
/// the rules every session must follow — chief among them that the agent CAN
/// read images via the `image-tools` skill even though the main model has no
/// native vision (never answer "I can't view images"). Non-clobbering: a file
/// the user already wrote is left untouched; only a missing/empty file is
/// seeded, so this cannot override later user edits or future app policy.
fn ensure_global_memory(app: &AppHandle) {
    let Some(path) = global_memory_path(app) else {
        return;
    };
    if path.exists() {
        // A blank file (e.g. a leftover from an interrupted write) is seeded
        // like a missing one; anything with content is the user's own.
        if path.metadata().map(|m| m.len() > 0).unwrap_or(true) {
            return;
        }
    }
    if let Err(e) = std::fs::create_dir_all(path.parent().unwrap_or(path.as_path())) {
        eprintln!("global memory dir create failed: {e}");
        return;
    }
    const MEMORY: &str = r#"# Global Memory

Foundational awareness loaded for every session.

## You CAN read images (识图)

- The main model may have no native vision, so a pasted/shown image often cannot be
  seen directly through the Read tool — that is **expected**, not a dead end.
- Whenever you need to understand, OCR, or extract data from an image (an attached
  image, a screenshot you captured, a workspace figure, a chart/table/photo), use the
  `image-tools` skill and run its scripts (they route the image to a vision model):
  ```bash
  python3 scripts/recognize.py describe <img> --lang zh   # general recognition
  python3 scripts/recognize.py ocr <img> --lang zh        # verbatim text extraction
  python3 scripts/recognize.py read <img> --kind chart|table|figure   # structured
  ```
- **Never say "I cannot view images".** Say you will read it with the vision model,
  then actually do it and report what the image shows.
- Image models are NOT chat models: always go through the scripts (chat/completions
  for reading, images/generations for generating) — never chat with them.
"#;
    if let Err(e) = std::fs::write(&path, MEMORY) {
        eprintln!("global memory seed failed: {e}");
    }
}

/// Deploy the dependency-free guard that removes model-supplied browser launch
/// overrides before dsh forwards a tool call to the official MCP server.
fn deploy_browser_guard_plugin(app: &AppHandle) -> Option<PathBuf> {
    let src = app
        .path()
        .resolve(
            "browser-plugin/browser-guard.ts",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .filter(|p| p.is_file())?;
    let config_dir = xdg_config_home(app).ok()?.join("dsh");
    let dst = config_dir.join("browser-guard.ts");
    std::fs::create_dir_all(&config_dir).ok()?;
    if let Err(e) = std::fs::copy(&src, &dst) {
        eprintln!("failed to deploy browser guard plugin: {e}");
        return None;
    }
    Some(dst)
}

/// Ship app-owned custom tools into dsh's global tools directory. These
/// tools expose safe, declarative host capabilities (for example, asking the
/// UI to present an existing workspace artifact); they never hand the model a
/// raw window handle or filesystem access outside the active workspace.
fn deploy_workbench_tools(app: &AppHandle) {
    let Ok(src) = app
        .path()
        .resolve("tools", tauri::path::BaseDirectory::Resource)
    else {
        return;
    };
    if !src.is_dir() {
        return;
    }
    let Ok(config_home) = xdg_config_home(app) else {
        return;
    };
    let dst = config_home.join("dsh").join("tools");
    if let Err(e) = std::fs::create_dir_all(&dst) {
        eprintln!("failed to create workbench tools directory: {e}");
        return;
    }
    let Ok(entries) = std::fs::read_dir(&src) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        if let Err(e) = std::fs::copy(&path, dst.join(name)) {
            eprintln!("failed to deploy workbench tool {}: {e}", path.display());
        }
    }
}

/// Ship app-owned slash commands into dsh's global command directory. Agent
/// presets use a different native format and are deployed below.
fn deploy_profile_commands(app: &AppHandle) {
    let Ok(config_home) = xdg_config_home(app) else {
        return;
    };
    let Ok(src) = app
        .path()
        .resolve("profile/command", tauri::path::BaseDirectory::Resource)
    else {
        return;
    };
    if !src.is_dir() {
        return;
    }
    let dst = config_home.join("dsh").join("command");
    if let Err(e) = std::fs::create_dir_all(&dst) {
        eprintln!("failed to create profile command directory: {e}");
        return;
    }
    let Ok(entries) = std::fs::read_dir(&src) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || path.extension() != Some(std::ffi::OsStr::new("md")) {
            continue;
        }
        let Some(name) = path.file_name() else { continue };
        if let Err(e) = std::fs::copy(&path, dst.join(name)) {
            eprintln!("failed to deploy profile command {}: {e}", path.display());
        }
    }
}

/// Deploy DeepLab-owned native dsh presets into the app-private writable
/// roster. Each child must contain `agent.cordis.yml`; same-named app presets
/// are refreshed at startup, while user presets are left untouched.
fn deploy_agent_presets(app: &AppHandle, dsh_home: &Path) {
    let Ok(src) = app
        .path()
        .resolve("profile/presets", tauri::path::BaseDirectory::Resource)
    else {
        return;
    };
    if !src.is_dir() {
        return;
    }
    let dst = dsh_home.join(".agent-presets");
    let Ok(entries) = std::fs::read_dir(&src) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("agent.cordis.yml").is_file() {
            continue;
        }
        let target = dst.join(entry.file_name());
        let result = (|| -> std::io::Result<()> {
            if target.exists() {
                std::fs::remove_dir_all(&target)?;
            }
            copy_dir(&path, &target)
        })();
        if let Err(e) = result {
            eprintln!("failed to deploy agent preset {}: {e}", path.display());
        }
    }
}

/// Remove every SKILL.md-bearing directory in `dst` whose name is not in
/// `bundled` (the set just deployed). Non-skill directories — including the
/// reserved `user/` tree of installed skills — are left untouched.
fn prune_stale_skills(dst: &Path, bundled: &std::collections::HashSet<std::ffi::OsString>) {
    let Ok(entries) = std::fs::read_dir(dst) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name() == std::ffi::OsStr::new(USER_SKILLS_DIR) {
            continue;
        }
        if path.is_dir()
            && path.join("SKILL.md").is_file()
            && !bundled.contains(&entry.file_name())
        {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// Copy every skill directory under `src` into `dst`, replacing same-named
/// directories (so bundled updates win) and leaving everything else in `dst`
/// alone. Returns the names of the skill directories it deployed (for stale
/// pruning). Directories without a SKILL.md (placeholders) are skipped.
fn sync_skill_pack(src: &Path, dst: &Path) -> std::io::Result<Vec<std::ffi::OsString>> {
    std::fs::create_dir_all(dst)?;
    let mut deployed = Vec::new();
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        // `user/` belongs to the installed skills — a pack may never claim it.
        if entry.file_name() == std::ffi::OsStr::new(USER_SKILLS_DIR) {
            continue;
        }
        let target = dst.join(entry.file_name());
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        copy_dir(&entry.path(), &target)?;
        deployed.push(entry.file_name());
    }
    Ok(deployed)
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// Reserved subdirectory of the profile's global skills dir holding the skills
/// the USER installs. It lives inside a directory dsh already scans
/// (`<xdg-config>/dsh/skills/`, matched recursively by both skill loaders),
/// so an installed skill is available in EVERY workspace — a session's own
/// `.dsh/skills/` would vanish with the next dated session folder (#61).
/// Bundled-pack pruning skips this name, so app upgrades never delete it.
const USER_SKILLS_DIR: &str = "user";

fn user_skills_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dsh_home(app)?.join("skills").join(USER_SKILLS_DIR))
}

/// The `name:` from a SKILL.md's YAML frontmatter, or None when the text is not
/// a skill file (no leading frontmatter, no usable name).
fn skill_name_from_markdown(text: &str) -> Option<String> {
    let front = text
        .trim_start_matches('\u{feff}')
        .trim_start()
        .strip_prefix("---")?
        .split_once("\n---")?
        .0
        .to_string();
    front.lines().find_map(|line| {
        let value = line.trim().strip_prefix("name:")?;
        sanitize_skill_name(value.trim().trim_matches(['"', '\'']))
    })
}

/// A skill's name doubles as its directory name — accept only what cannot
/// escape the skills dir (no separators, no `..`, no hidden names).
fn sanitize_skill_name(name: &str) -> Option<String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then(|| name.to_string())
}

/// Skill directories in the active workspace's `.dsh/skills/`.
fn workspace_skill_dirs(workspace: &Path) -> Vec<PathBuf> {
    let root = workspace.join(".dsh").join("skills");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join("SKILL.md").is_file())
        .collect()
}

fn dir_name(path: &Path) -> Option<&str> {
    path.file_name().and_then(|n| n.to_str())
}

/// Install a pasted SKILL.md straight into the profile's user skills dir — no
/// model turn, no provider needed — and restart the sidecar so dsh
/// rediscovers it (discovery is cached per instance). Returns the skill's name.
#[tauri::command(async)]
pub fn install_skill_markdown(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    text: String,
) -> Result<String, String> {
    let name = skill_name_from_markdown(&text)
        .ok_or_else(|| "not a skill file: it needs YAML frontmatter with a `name:`".to_string())?;
    // A bundled pack owns its name: two skills sharing one name make dsh
    // pick whichever it scanned last, so refuse instead of shadowing.
    if xdg_config_home(&app)?
        .join("dsh")
        .join("skills")
        .join(&name)
        .join("SKILL.md")
        .is_file()
    {
        return Err(format!("a bundled skill is already called \"{name}\""));
    }
    let dir = user_skills_dir(&app)?.join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("SKILL.md"), text.as_bytes()).map_err(|e| e.to_string())?;
    restart_sidecar_if_running(&app, &state)?;
    Ok(name)
}

/// Names already in the workspace's `.dsh/skills/`. Taken before an agent
/// install runs so `adopt_workspace_skills` can tell what it added.
#[tauri::command(async)]
pub fn workspace_skill_names(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(workspace_skill_dirs(&workspace_dir(&app)?)
        .iter()
        .filter_map(|p| dir_name(p).map(str::to_owned))
        .collect())
}

/// Move skills the agent just wrote into the workspace over to the profile's
/// user skills dir, so they outlive that session's folder. `known` is the
/// pre-install listing — a pinned project's own skills stay project-scoped.
/// The workspace copy is dropped once the profile copy is in place: leaving both
/// would give dsh two skills with the same name, and it then picks whichever
/// it scanned last. Restarts the sidecar when anything moved; returns the names.
#[tauri::command(async)]
pub fn adopt_workspace_skills(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    known: Vec<String>,
) -> Result<Vec<String>, String> {
    let dst_root = user_skills_dir(&app)?;
    let mut adopted = Vec::new();
    for src in workspace_skill_dirs(&workspace_dir(&app)?) {
        let Some(name) = dir_name(&src) else { continue };
        if known.iter().any(|k| k == name) || sanitize_skill_name(name).is_none() {
            continue;
        }
        let dst = dst_root.join(name);
        if dst.exists() {
            std::fs::remove_dir_all(&dst).map_err(|e| e.to_string())?;
        }
        copy_dir(&src, &dst).map_err(|e| e.to_string())?;
        // Only now that the profile copy exists — a failed cleanup leaves a
        // harmless duplicate, never a lost skill.
        if let Err(e) = std::fs::remove_dir_all(&src) {
            eprintln!("could not remove the workspace copy of {name}: {e}");
        }
        adopted.push(name.to_string());
    }
    if !adopted.is_empty() {
        restart_sidecar_if_running(&app, &state)?;
    }
    Ok(adopted)
}

/// PATH for the sidecar (and everything the agent runs through it). Apps
/// launched from Finder/Dock/a desktop entry get a minimal PATH, so the agent
/// would not find the user's Python/conda/Homebrew tools. Prepend the
/// well-known locations that actually exist — the platform lists differ
/// (macOS Homebrew vs. Linux /opt/conda & Linuxbrew), same as python_candidates.
#[cfg(unix)]
pub(crate) fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();

    #[cfg(target_os = "macos")]
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/anaconda3/bin"),
        format!("{home}/miniconda3/bin"),
        "/opt/anaconda3/bin".to_string(),
        "/opt/miniconda3/bin".to_string(),
        format!("{home}/.pyenv/shims"),
        format!("{home}/.local/bin"),
    ];
    #[cfg(target_os = "linux")]
    let extras = [
        format!("{home}/anaconda3/bin"),
        format!("{home}/miniconda3/bin"),
        "/opt/conda/bin".to_string(),
        "/opt/anaconda3/bin".to_string(),
        "/opt/miniconda3/bin".to_string(),
        format!("{home}/.pyenv/shims"),
        "/home/linuxbrew/.linuxbrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "linux")))]
    let extras = [
        format!("{home}/.pyenv/shims"),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];

    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| !base.split(':').any(|b| b == p) && std::path::Path::new(p).is_dir())
        .collect();
    if !base.is_empty() {
        parts.push(base);
    }
    parts.join(":")
}

/// Windows twin of the unix version above: GUI apps inherit a PATH without the
/// user's Python/conda, and Anaconda famously does NOT add itself to PATH.
/// Prepend the conda install roots that exist — including `Library\bin`, which
/// conda pythons need on PATH for their DLLs (numpy fails to import otherwise).
#[cfg(windows)]
pub(crate) fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut roots: Vec<String> = Vec::new();
    if let Ok(profile) = std::env::var("USERPROFILE") {
        roots.push(format!("{profile}\\anaconda3"));
        roots.push(format!("{profile}\\miniconda3"));
    }
    roots.push("C:\\ProgramData\\anaconda3".into());
    roots.push("C:\\ProgramData\\miniconda3".into());
    let mut extras: Vec<String> = Vec::new();
    for root in roots {
        for dir in [root.clone(), format!("{root}\\Scripts"), format!("{root}\\Library\\bin")] {
            extras.push(dir);
        }
    }
    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| {
            !base.split(';').any(|b| b.eq_ignore_ascii_case(p)) && Path::new(p).is_dir()
        })
        .collect();
    if !base.is_empty() {
        parts.push(base);
    }
    parts.join(";")
}

/// On-disk path of a bundled sidecar (`externalBin`), if it is there. Tauri
/// places them next to the app executable with the target-triple suffix
/// stripped. Needed whenever something other than `ShellExt::sidecar` has to
/// reach one: dsh spawning an MCP server by path, or a synchronous probe.
pub(crate) fn sidecar_bin(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let bin = exe.parent()?.join(file);
    bin.exists().then_some(bin)
}

/// A `std::process::Command` that never pops a console window on Windows.
/// A GUI app spawning a console-subsystem child (python.exe, taskkill, git…)
/// otherwise flashes a black window per spawn — every direct spawn in this
/// crate must go through here. (Sidecars via tauri_plugin_shell already set
/// the flag internally.)
pub(crate) fn quiet_command(bin: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Make a secret-holding path owner-only: 700 for directories, 600 for files
/// (unix). The runtime root carries provider/connector API keys in
/// `dsh.jsonc`/`auth.json`, and the sidecar rewrites those files with a
/// default umask while running — locking the DIRECTORY is what holds, since a
/// 700 dir is unreachable for other users whatever the file modes inside. On
/// Windows, %APPDATA% is per-user ACL'd already; nothing to do.
pub(crate) fn tighten_private(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(path) {
            let mode = if meta.is_dir() { 0o700 } else { 0o600 };
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

/// `bytes` bytes of OS randomness as lowercase hex. Panics only if the OS
/// CSPRNG is unavailable — a machine state where serving anything is unsafe.
pub(crate) fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).expect("OS random source unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Expose the internal gateway's token to the frontend SDK client. Every
/// request the WebView sends to the same-origin gateway carries this as its
/// bearer token; Tauri IPC is app-only, so it never reaches a remote page.
#[tauri::command]
pub fn runtime_password(app: AppHandle) -> String {
    let state = app.state::<RuntimeState>();
    let lifecycle = state.lifecycle.lock().unwrap();
    lifecycle.gateway_token.clone().unwrap_or_default()
}

/// Internal gateway address and token for native auxiliary windows.
/// The token stays in Rust and is only embedded in the private loopback URL.
pub(crate) fn gateway_access(state: &RuntimeState) -> Option<(String, String)> {
    let lifecycle = state.lifecycle.lock().ok()?;
    Some((
        lifecycle.url.clone()?,
        lifecycle.gateway_token.clone()?,
    ))
}

pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(43917)
}

/// Network-proxy setting for the sidecar: `system` (default) follows the OS,
/// `custom <url>` uses a fixed proxy, `none` forces direct connections.
/// Stored as one line in `proxy.txt` under the runtime root.
fn proxy_setting_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("proxy.txt"))
}

/// The persisted proxy setting as (mode, url). Unknown/missing → system.
fn read_proxy_setting(app: &AppHandle) -> (String, String) {
    let raw = proxy_setting_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let line = raw.lines().next().unwrap_or("").trim();
    match line.split_once(' ') {
        Some(("custom", url)) if !url.trim().is_empty() => ("custom".into(), url.trim().into()),
        _ if line == "none" => ("none".into(), String::new()),
        _ => ("system".into(), String::new()),
    }
}

/// Accept `http://`, `https://` or `socks5://` with a host:port.
fn validate_proxy_url(url: &str) -> Result<(), String> {
    let rest = ["http://", "https://", "socks5://"]
        .iter()
        .find_map(|s| url.strip_prefix(s))
        .ok_or("proxy URL must start with http://, https:// or socks5://")?;
    let hostport = rest.trim_end_matches('/');
    let (host, port) = hostport
        .rsplit_once(':')
        .ok_or("proxy URL needs a host:port")?;
    if host.is_empty() || port.parse::<u16>().is_err() {
        return Err("proxy URL needs a host:port".into());
    }
    Ok(())
}

/// Proxy env for the sidecar. A GUI app launched from Finder/Dock inherits no
/// shell environment, so a user whose traffic runs through a system proxy
/// (common where provider hosts are unreachable directly) gets a sidecar that
/// cannot reach them: its fetch honors HTTP(S)_PROXY but nothing sets it.
/// Resolved from the persisted setting: `system` mirrors the OS proxy (an
/// existing env always wins — a terminal launch already carries the user's own
/// values), `custom` pins the user's URL, `none` neutralizes even inherited
/// env. Verified live with xAI OAuth (#9): the proxied browser delivers the
/// code, then the sidecar's token exchange to auth.x.ai hangs without a proxy
/// and succeeds with one.
fn resolve_proxy_env(mode: &str, url: &str) -> Vec<(&'static str, String)> {
    // Loopback traffic (the sidecar's own API, provider OAuth callback
    // servers) must never route through a proxy.
    const NO_PROXY_LOOPBACK: &str = "localhost,127.0.0.1,::1";
    match mode {
        "none" => vec![
            ("HTTP_PROXY", String::new()),
            ("HTTPS_PROXY", String::new()),
            ("http_proxy", String::new()),
            ("https_proxy", String::new()),
            ("ALL_PROXY", String::new()),
            ("NO_PROXY", "*".to_string()),
        ],
        "custom" => vec![
            ("HTTP_PROXY", url.to_string()),
            ("HTTPS_PROXY", url.to_string()),
            ("NO_PROXY", NO_PROXY_LOOPBACK.to_string()),
        ],
        _ => {
            if ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
                .iter()
                .any(|k| std::env::var_os(k).is_some())
            {
                return Vec::new();
            }
            match system_proxy_url() {
                Some(sys) => vec![
                    ("HTTP_PROXY", sys.clone()),
                    ("HTTPS_PROXY", sys),
                    ("NO_PROXY", NO_PROXY_LOOPBACK.to_string()),
                ],
                None => Vec::new(),
            }
        }
    }
}

/// The proxy the sidecar would actually use right now, for display in
/// Settings. None ⇒ direct connections.
fn effective_proxy(mode: &str, url: &str) -> Option<String> {
    match mode {
        "none" => None,
        "custom" => Some(url.to_string()),
        _ => ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
            .or_else(system_proxy_url),
    }
}

/// PyPI-index and Python-download mirrors for the bundled uv, stored one per
/// line (`pypi <url>` / `python <url>`) in `mirrors.txt` under the runtime root.
/// Empty ⇒ uv's defaults (pypi.org / github.com). Only the uv provisioning
/// flows read these — no long-running sidecar to restart.
fn mirror_setting_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("mirrors.txt"))
}

/// The persisted mirrors as (pypi_index_url, python_install_mirror_url).
fn read_mirror_setting(app: &AppHandle) -> (String, String) {
    let raw = mirror_setting_file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default();
    let (mut pypi, mut python) = (String::new(), String::new());
    for line in raw.lines() {
        match line.trim().split_once(' ') {
            Some(("pypi", v)) => pypi = v.trim().to_string(),
            Some(("python", v)) => python = v.trim().to_string(),
            _ => {}
        }
    }
    (pypi, python)
}

/// Accept an `http(s)://` URL with a non-empty host.
fn validate_mirror_url(url: &str) -> Result<(), String> {
    let rest = ["https://", "http://"]
        .iter()
        .find_map(|s| url.strip_prefix(s))
        .ok_or("mirror URL must start with http:// or https://")?;
    if rest.trim_matches('/').is_empty() {
        return Err("mirror URL needs a host".into());
    }
    Ok(())
}

/// Network env for the bundled uv sidecar (managed-Python download + pip
/// install). Mirrors the dsh sidecar's proxy so first-run provisioning
/// works behind the same proxy the agent uses, and adds the optional PyPI /
/// Python-download mirrors. uv reads HTTP(S)_PROXY, `UV_DEFAULT_INDEX` and
/// `UV_PYTHON_INSTALL_MIRROR` from its environment.
pub(crate) fn uv_network_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    let (mode, url) = read_proxy_setting(app);
    let mut env = resolve_proxy_env(&mode, &url);
    let (pypi, python) = read_mirror_setting(app);
    if !pypi.is_empty() {
        env.push(("UV_DEFAULT_INDEX", pypi));
    }
    if !python.is_empty() {
        env.push(("UV_PYTHON_INSTALL_MIRROR", python));
    }
    env
}

/// Proxy env for a bundled sidecar OTHER than dsh (e.g. agent-browser's
/// Chrome download). Same resolution as the dsh sidecar so a first-run
/// browser install works behind the user's configured proxy, without the uv
/// mirror vars that only uv understands.
pub(crate) fn sidecar_proxy_env(app: &AppHandle) -> Vec<(&'static str, String)> {
    let (mode, url) = read_proxy_setting(app);
    resolve_proxy_env(&mode, &url)
}

/// The system-configured proxy as a URL, if one is enabled (macOS: scutil).
/// HTTP(S) proxies are preferred — an HTTPS proxy endpoint still speaks plain
/// HTTP CONNECT, hence the http:// scheme — with SOCKS as the fallback.
#[cfg(target_os = "macos")]
fn system_proxy_url() -> Option<String> {
    let out = quiet_command("scutil").arg("--proxy").output().ok()?;
    parse_scutil_proxy(&String::from_utf8_lossy(&out.stdout))
}

/// Parse `scutil --proxy` output (`  Key : value` lines) into a proxy URL.
fn parse_scutil_proxy(text: &str) -> Option<String> {
    let get = |key: &str| -> Option<String> {
        let prefix = format!("{key} : ");
        text.lines()
            .find_map(|l| l.trim().strip_prefix(prefix.as_str()).map(|v| v.trim().to_string()))
    };
    let enabled = |key: &str| get(key).as_deref() == Some("1");
    for (en, host, port, scheme) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "http"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort", "http"),
        ("SOCKSEnable", "SOCKSProxy", "SOCKSPort", "socks5"),
    ] {
        if enabled(en) {
            if let (Some(h), Some(p)) = (get(host), get(port)) {
                return Some(format!("{scheme}://{h}:{p}"));
            }
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn system_proxy_url() -> Option<String> {
    // Windows/Linux: terminal-launched apps inherit the user's proxy env
    // (covered by the passthrough above); no OS store is read here yet.
    None
}

fn drain_dsh_output<R>(app: AppHandle, mut output: R)
where
    R: std::io::Read + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match output.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for line in String::from_utf8_lossy(&buf[..n]).split(['\n', '\r']) {
                        let line = line.trim();
                        if !line.is_empty() {
                            crate::debug_log::append(&app, &format!("[dsh] {line}"));
                        }
                    }
                }
            }
        }
    });
}

fn spawn_sidecar(app: &AppHandle, port: u16) -> Result<std::process::Child, String> {
    let root = runtime_root(app)?;
    let cfg = root.join("xdg-config");
    let data = root.join("xdg-data");
    let cache = root.join("xdg-cache");
    let state = root.join("xdg-state");
    let dsh_home = root.join("dsh-home");
    // Require a resolvable user-facing workspace (the sidecar's current_dir is
    // the bundled dsh resource, not the app cwd — which is `/` when launched
    // from Finder).
    let _workspace = workspace_dir(app)?;
    for d in [&cfg, &data, &cache, &state, &dsh_home, &dsh_home.join("agents")] {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // Ship the bundled scientific skills into the app-private dsh home's
    // `skills/` directory, which dsh scans for every session.
    deploy_bundled_skills(app, &dsh_home);
    // Host presentation tools are global to the app-owned dsh home and
    // available in every session workspace.
    deploy_workbench_tools(app);
    // Ensure the global memory file exists (the rule that makes every session
    // "read images through the image-tools skill" is code-enforced here, not
    // just documented). Non-clobbering: an edited MEMORY.md is left alone.
    ensure_global_memory(app);
    // DeepLab commands and native dsh presets, refreshed on every start.
    deploy_profile_commands(app);
    deploy_agent_presets(app, &dsh_home);
    // Secrets live under the runtime root (provider/connector keys) —
    // owner-only on every start, so existing installs are repaired and whatever
    // the sidecar later rewrites inside stays unreachable to other users
    // regardless of its umask.
    tighten_private(&root);
    let home = std::env::var("HOME").unwrap_or_default();
    let port_str = port.to_string();

    // dsh is a Node CLI (`@deepseek-ai/dsh`), bundled as a resource next to a
    // launcher that re-anchors the CLI onto its own directory. The sidecar is
    // spawned as `node <launcher> --profile web --host 127.0.0.1 --port <port>`,
    // so it needs node on PATH (dev: system node; releases bundle one).
    // dsh is a Node CLI (`@deepseek-ai/dsh`), bundled under the dsh resource.
    // The launcher.mjs wrapper exists to re-anchor dsh's launch cwd onto the
    // resource dir (dsh resolves its profile from cwd), but under LaunchServices
    // (`open` / Dock) that chdir/spawn step hangs and the sidecar never comes
    // up — observed as `timed out waiting for the dsh sidecar to listen`. Spawn
    // the CLI directly with current_dir already set to the resource dir, which
    // achieves the same anchor without the wrapper's fork.
    let dsh_dir = app
        .path()
        .resolve("dsh", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("dsh resource not found: {e}"))?;
    // current_dir is the bundled dsh resource below, so a relative entry point
    // avoids Windows command-line path rewriting while remaining deterministic.
    let cli = "node_modules/@deepseek-ai/dsh/lib/bin.js";
    let node = std::env::var("DEEPLAB_NODE").unwrap_or_else(|_| "node".to_string());
    // Render the app-owned MCP inventory against this installation's current
    // Node and resource paths before every boot. App upgrades may move either.
    let mcp_patch = crate::dsh_mcp::refresh_patch(app)?;

    let mut builder = quiet_command(node);
    builder
        .arg(&cli)
        .args(["--profile", "web", "--patch"])
        .arg(&mcp_patch)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            port_str.as_str(),
            "--no-open",
        ])
        // App-private dirs: dsh never touches the user's ~/.dsh. DSH_AGENTS_HOME
        // isolates the user-level `~/.agents/skills` pack — a legacy Open Lab
        // install may carry Chinese-reviewed skills there that must not leak
        // into DeepLab sessions — pointing dsh at the app's own (empty) agents
        // dir instead, so only workspace `.dsh/skills` + the bundled packs
        // contribute.
        .env("DSH_HOME", dsh_home.to_string_lossy().to_string())
        .env("DSH_AGENTS_HOME", dsh_home.join("agents").to_string_lossy().to_string())
        .env("XDG_CONFIG_HOME", cfg.to_string_lossy().to_string())
        .env("XDG_DATA_HOME", data.to_string_lossy().to_string())
        .env("XDG_CACHE_HOME", cache.to_string_lossy().to_string())
        .env("XDG_STATE_HOME", state.to_string_lossy().to_string())
        .env("HOME", home)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Lets bundled skill helpers (e.g. remote-compute's record_run.py) stamp
        // the recording app version into provenance — they run outside the app
        // and can't otherwise know it.
        .env("OPENSCIENCE_APP_VERSION", app.package_info().version.to_string())
        .current_dir(&dsh_dir);
    // GUI-launched apps get a minimal PATH; give the agent the user's real tools.
    builder.env("PATH", enriched_path());
    // The agent's own `ssh`/`rsync`/`sbatch` calls ride the app's shared
    // connection through this config, so a host the user signed in to once needs
    // no further password or one-time code (#73). The bundled remote-compute
    // skill and the ssh_connect tool both pass `-F "$OPENSCIENCE_SSH_CONFIG"`.
    if let Some(ssh_config) = crate::ssh_session::config_path(app) {
        builder.env("OPENSCIENCE_SSH_CONFIG", ssh_config.to_string_lossy().to_string());
    }
    // Apply the network-proxy setting so provider logins and API calls work
    // where direct connections are blocked (see resolve_proxy_env).
    let (proxy_mode, proxy_url) = read_proxy_setting(app);
    for (k, v) in resolve_proxy_env(&proxy_mode, &proxy_url) {
        builder.env(k, v);
    }

    let mut child = builder.spawn().map_err(|e| format!("failed to spawn dsh: {e}"))?;
    // Drain both streams so a full pipe cannot block startup. dsh reports some
    // launch failures on stdout, so both belong in the app's private debug log.
    if let Some(stdout) = child.stdout.take() {
        drain_dsh_output(app.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        drain_dsh_output(app.clone(), stderr);
    }
    Ok(child)
}

/// Poll the sidecar's HTTP surface until it answers (or a deadline passes).
/// A packaged cold start scans the complete bundled dependency and skill trees,
/// which can take longer than a development start on Windows.
fn wait_for_sidecar(url: &str, child: &mut std::process::Child) -> Result<(), String> {
    let authority = url.trim_start_matches("http://");
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
    while std::time::Instant::now() < deadline {
        if TcpStream::connect(authority).is_ok() {
            return Ok(());
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!("dsh sidecar exited before listening ({status})"));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Err("timed out waiting for the dsh sidecar to listen".into())
}

fn spawn_ready_sidecar(
    app: &AppHandle,
    preferred_port: Option<u16>,
) -> Result<(std::process::Child, u16, String), String> {
    const MAX_ATTEMPTS: usize = 3;
    let mut port = preferred_port.unwrap_or_else(free_port);
    let mut last_error = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        let sidecar_url = format!("http://127.0.0.1:{port}");
        match spawn_sidecar(app, port) {
            Ok(mut child) => match wait_for_sidecar(&sidecar_url, &mut child) {
                Ok(()) => return Ok((child, port, sidecar_url)),
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    last_error = error;
                }
            },
            Err(error) => last_error = error,
        }
        crate::debug_log::append(
            app,
            &format!(
                "dsh start attempt {attempt}/{MAX_ATTEMPTS} failed on port {port}: {last_error}"
            ),
        );
        let previous = port;
        port = free_port();
        while port == previous {
            port = free_port();
        }
    }

    Err(format!(
        "dsh sidecar failed after {MAX_ATTEMPTS} attempts: {last_error}"
    ))
}

/// Kill and respawn a running sidecar on its stable port. The existing gateway
/// remains live: it resolves `sidecar_url` for every proxied request, so keeping
/// its URL and token stable lets the frontend reconnect after the sidecar boots.
pub(crate) fn restart_sidecar_if_running(
    app: &AppHandle,
    state: &RuntimeState,
) -> Result<Option<String>, String> {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    let Some(mut child) = lifecycle.child.take() else {
        lifecycle.url = None;
        lifecycle.sidecar_url = None;
        return Ok(None);
    };
    let _ = child.kill();
    let _ = child.wait();
    lifecycle.sidecar_url = None;

    let preferred_port = lifecycle.port;
    let (mut child, port, sidecar_url) = spawn_ready_sidecar(app, preferred_port)
        .map_err(|error| format!("dsh sidecar failed to restart: {error}"))?;
    let url = if let Some(url) = lifecycle.url.clone() {
        url
    } else {
        let gw_state = app.state::<crate::gateway::GatewayState>().inner();
        let (gw_port, gw_token) = match crate::gateway::start_internal(app, gw_state) {
            Ok(result) => result,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        lifecycle.gateway_token = Some(gw_token);
        format!("http://127.0.0.1:{gw_port}")
    };
    lifecycle.port = Some(port);
    lifecycle.child = Some(child);
    lifecycle.sidecar_url = Some(sidecar_url);
    lifecycle.url = Some(url.clone());
    Ok(Some(url))
}

/// Start the bundled dsh (idempotent). Returns its base URL. `async`:
/// skill-pack deployment + process spawn at startup must not block the UI
/// thread while the first window paints.
#[tauri::command(async)]
pub fn start_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<String, String> {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    let child_running = match lifecycle.child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(None) => true,
            Ok(Some(status)) => {
                crate::debug_log::append(
                    &app,
                    &format!("dsh sidecar exited; restarting it ({status})"),
                );
                false
            }
            Err(error) => {
                crate::debug_log::append(
                    &app,
                    &format!("could not inspect dsh sidecar; restarting it ({error})"),
                );
                false
            }
        },
        None => false,
    };
    if child_running && lifecycle.url.is_some() {
        let url = lifecycle.url.as_ref().unwrap();
        return Ok(url.clone());
    }
    // Repair an exited child or any impossible partial state left by an older
    // build or failed transition. Keep a live gateway: it can proxy the newly
    // spawned sidecar on the same stable port without changing the UI URL.
    if let Some(mut child) = lifecycle.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    lifecycle.sidecar_url = None;

    // Prefer the stable port, but retry with a fresh one when Windows hands the
    // process a transiently unbindable port (observed as Node EACCES).
    let preferred_port = lifecycle.port;
    let (child, port, sidecar_url) = spawn_ready_sidecar(&app, preferred_port)?;
    // The desktop shell talks to the sidecar through a same-origin gateway:
    // the WebView origin (tauri://localhost) cannot reach the loopback sidecar
    // cross-origin (dsh's browser-trust fence), so the gateway serves the SPA
    // and proxies /api + the WebSocket streams at its own origin, and the
    // frontend authenticates with the returned token.
    let url = if let Some(url) = lifecycle.url.clone() {
        url
    } else {
        let gw_state = app.state::<crate::gateway::GatewayState>().inner();
        let (gw_port, gw_token) = crate::gateway::start_internal(&app, gw_state)?;
        lifecycle.gateway_token = Some(gw_token);
        format!("http://127.0.0.1:{gw_port}")
    };
    lifecycle.port = Some(port);
    lifecycle.child = Some(child);
    lifecycle.url = Some(url.clone());
    lifecycle.sidecar_url = Some(sidecar_url);
    Ok(url)
}

/// The workspace directory the sidecar runs in — the frontend passes it to the
/// SDK so skill discovery is scoped to the right dsh instance.
#[tauri::command]
pub fn workspace_path(app: AppHandle) -> Result<String, String> {
    Ok(workspace_dir(&app)?.to_string_lossy().to_string())
}

/// The base folder containing projects and sessions (`~/Documents/DeepLab`).
#[tauri::command]
pub fn workspace_base(app: AppHandle) -> Result<String, String> {
    Ok(base_workspace_dir(&app)?.to_string_lossy().to_string())
}

/// Choose the base folder (Settings → Workspace → Change). Creates its
/// `projects/` and `sessions/` collections and persists the choice. Existing
/// workspaces keep their folders.
#[tauri::command]
pub fn set_workspace_base(app: AppHandle, path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("workspace base must be absolute".into());
    }
    ensure_base_layout(dir.clone()).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = crate::artifact_file::native_path(&dir.canonicalize().map_err(|e| e.to_string())?);
    std::fs::write(base_workspace_file(&app)?, canon.as_bytes()).map_err(|e| e.to_string())?;
    Ok(canon)
}

/// Reveal the base workspace folder in the OS file manager. (The sandboxed
/// `open_path` resolves inside the ACTIVE workspace only, which may be a dated
/// subfolder — the base needs its own door.)
#[tauri::command]
pub fn open_workspace_base(app: AppHandle) -> Result<(), String> {
    crate::artifact_file::os_open(&base_workspace_dir(&app)?)
}

/// Switch the active workspace folder: create it if needed and persist the
/// choice. The kernel / Files / provenance read the folder via `workspace_dir`;
/// the agent runtime is scoped per request — the frontend reconnects its event
/// stream with `?directory=` and creates sessions with it (a bare `/event`
/// stream would not see other folders' instances, so the scoped stream is
/// required). `path` must be absolute.
#[tauri::command(async)]
pub fn set_workspace(
    app: AppHandle,
    _state: State<'_, RuntimeState>,
    path: String,
) -> Result<String, String> {
    let dir = resolve_workspace_path(&app, &PathBuf::from(&path));
    if !dir.is_absolute() {
        return Err("workspace path must be absolute".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    // Persisted and returned in native form — on Windows the verbatim `\\?\`
    // path `canonicalize()` produces matches nothing the sidecar reports (#76).
    let native = crate::artifact_file::native_path(&canon);
    std::fs::write(active_workspace_file(&app)?, native.as_bytes()).map_err(|e| e.to_string())?;

    // Follow the active folder with the snapshot watcher so out-of-app edits
    // (external editor, detached process) in the new workspace are captured too.
    crate::git_snapshot::watch_workspace(&canon);

    // No sidecar restart: dsh serves every folder from one process via
    // per-directory instances, and the frontend reconnects its event stream
    // with `?directory=<new folder>`. Restarting here used to cost 3-6 s per
    // history-session switch (process boot + reconnect polling).
    // Jupyter-lab, however, pins its root_dir at spawn time — re-root it (in
    // the background) so agent-created notebooks land in the new folder.
    crate::jupyter::reroot_jupyter(&app);
    // Refresh this session's local copy of the remote-machine list from the
    // canonical base file, so a machine configured in Settings is visible to
    // every session's agent without reaching outside the workspace.
    crate::compute::materialize_active(&app);
    Ok(native)
}

/// Record which session owns the active workspace, so bundled skill helpers
/// (record_run.py) can stamp remote runs with their `sessionId` — the app knows
/// the id but the off-app helper only sees the workspace. Written as
/// `<workspace>/.openlab/session.txt`; best-effort, empty ids are ignored.
#[tauri::command]
pub fn mark_session(app: AppHandle, session_id: String) -> Result<(), String> {
    let id = session_id.trim();
    if id.is_empty() {
        return Ok(());
    }
    let dir = app_meta_dir(&workspace_dir(&app)?);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("session.txt");
    // Write-then-rename so a concurrent read never sees a half-written id.
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, id).map_err(|e| e.to_string())?;
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::write(&path, id);
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

/// Create a new dated folder `<base>/sessions/<name>` and switch to it. `name`
/// is a single path segment (the frontend supplies a timestamp); rejects
/// separators.
#[tauri::command(async)]
pub fn new_dated_workspace(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    name: String,
) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid folder name".into());
    }
    let dir = sessions_dir(&app)?.join(&name);
    // `set_workspace` moves `app`; keep a handle to seed the harness afterwards.
    let seed_app = app.clone();
    let canon = set_workspace(app, state, dir.to_string_lossy().to_string())?;
    // Seed the agent harness into the fresh folder so it starts with its
    // operating rules, not an empty directory. Only NEW dated folders get seeded
    // (never `set_workspace` alone — switching to an existing session must not
    // re-plant the scaffold).
    crate::harness::seed_harness(&seed_app, std::path::Path::new(&canon));
    crate::git_snapshot::commit_best_effort(std::path::Path::new(&canon), "Initialize workspace");
    Ok(canon)
}

/// Native "choose a folder" dialog; returns the absolute path, or None on cancel.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.map_err(|_| "folder dialog closed".to_string())? else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Characters a file name cannot carry on Windows/macOS/Linux, plus control
/// characters. Conversation titles are free text, so a title becomes a file
/// name only after this.
fn safe_file_stem(title: &str, fallback: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    // Windows also rejects a trailing dot or space.
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    // 80 chars leaves room for the id suffix and the extension inside the
    // 255-byte limit every mainstream filesystem enforces.
    let capped: String = trimmed.chars().take(80).collect();
    let capped = capped.trim().to_string();
    if capped.is_empty() {
        return fallback.to_string();
    }
    // Windows refuses these device names whatever the extension.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.iter().any(|r| capped.eq_ignore_ascii_case(r)) {
        return format!("{capped}-");
    }
    capped
}

/// Write one exported conversation into a folder the user picked in a native
/// dialog. Confined to that folder: the file name is derived from the title
/// (never used as a path), so a conversation called "../../.ssh/authorized_keys"
/// cannot escape it.
#[tauri::command]
pub fn write_export_file(
    directory: String,
    name: String,
    contents: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&directory);
    if !dir.is_dir() {
        return Err(format!("{directory} is not a folder"));
    }
    let stem = safe_file_stem(&name, "conversation");
    let mut path = dir.join(format!("{stem}.md"));
    // Two conversations can share a title; never silently overwrite one.
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).md"));
        n += 1;
        if n > 999 {
            return Err("too many files with that name".to_string());
        }
    }
    std::fs::write(&path, contents).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Kill the bundled dsh if running.
#[tauri::command]
pub fn stop_runtime(state: State<'_, RuntimeState>) {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    if let Some(mut child) = lifecycle.child.take() {
        let _ = child.kill();
    }
    lifecycle.url = None;
    lifecycle.sidecar_url = None;
    lifecycle.gateway_token = None;
}

pub fn kill_child(state: &RuntimeState) {
    let mut lifecycle = state.lifecycle.lock().unwrap();
    if let Some(mut child) = lifecycle.child.take() {
        let _ = child.kill();
    }
    lifecycle.url = None;
    lifecycle.sidecar_url = None;
    lifecycle.gateway_token = None;
}

#[cfg(test)]
mod tests {
    use super::{
        auth_has_provider, parse_scutil_proxy,
        ensure_base_layout, prune_stale_skills, random_hex, remove_key_from_config,
        resolve_proxy_env, skill_name_from_markdown, sync_skill_pack, validate_proxy_url,
        workspace_skill_dirs,
    };
    use std::fs;

    #[test]
    fn legacy_base_paths_rewrite_to_openlab() {
        let docs = std::env::temp_dir().join(format!("os-home-{}", std::process::id())).join("Documents");
        let mapped = |p: &str| docs.join("DeepLab").join(p);
        let rewrite = |p: &str| super::rewrite_legacy_base(&docs, &std::path::Path::new(p));

        // Old sessions point under the legacy bases — they map to the migrated
        // folder instead of resurrecting the old names.
        assert_eq!(
            rewrite(&docs.join("OpenLab/sessions/2026-07-01-0900").to_string_lossy()),
            mapped("sessions/2026-07-01-0900")
        );
        assert_eq!(
            rewrite(&docs.join("OpenScience/projects/p1").to_string_lossy()),
            mapped("projects/p1")
        );
        assert_eq!(
            rewrite(&docs.join("Open Science/projects/p2").to_string_lossy()),
            mapped("projects/p2")
        );
        // A path already under the current base (or unrelated) is untouched.
        assert_eq!(
            rewrite(&docs.join("DeepLab/projects/p2").to_string_lossy()),
            docs.join("DeepLab/projects/p2")
        );
        assert_eq!(
            rewrite("/somewhere/else/x"),
            std::path::PathBuf::from("/somewhere/else/x")
        );
    }

    #[test]
    fn legacy_path_keeps_live_data_else_maps_to_openlab() {
        let docs = std::env::temp_dir()
            .join(format!("os-resolve-{}", std::process::id()))
            .join("Documents");
        let legacy = docs.join("OpenLab/GM3_develop");
        let deeplab = docs.join("DeepLab/GM3_develop");
        let _ = fs::create_dir_all(&legacy);

        // The old folder still holds the session's files (the migration never
        // ran because DeepLab already existed) → keep using it, don't recreate
        // the old name, don't strand the data under an empty DeepLab folder.
        assert_eq!(super::resolve_legacy_decision(&deeplab, &legacy), legacy);
        // Once the old folder is gone, map to the DeepLab equivalent instead of
        // resurrecting `~/Documents/OpenLab`.
        fs::remove_dir_all(&legacy).unwrap();
        assert_eq!(super::resolve_legacy_decision(&deeplab, &legacy), deeplab);
        // Non-legacy paths are untouched either way.
        assert_eq!(super::resolve_legacy_decision(&deeplab, &deeplab), deeplab);
    }

    #[test]
    fn auth_store_provider_lookup() {
        let auth = r#"{ "openai": { "type": "oauth", "refresh": "r", "access": "a" } }"#;
        assert!(auth_has_provider(auth, "openai"));
        assert!(!auth_has_provider(auth, "anthropic"));
        assert!(!auth_has_provider("", "openai")); // empty/corrupt store
        assert!(!auth_has_provider("not json", "openai"));
    }

    #[test]
    fn base_layout_has_separate_project_and_session_collections() {
        let root =
            std::env::temp_dir().join(format!("os-workspace-layout-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        assert_eq!(ensure_base_layout(root.clone()).unwrap(), root);
        assert!(root.join("projects").is_dir());
        assert!(root.join("sessions").is_dir());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn proxy_url_validation() {
        assert!(validate_proxy_url("http://127.0.0.1:7890").is_ok());
        assert!(validate_proxy_url("socks5://10.0.0.2:1080").is_ok());
        assert!(validate_proxy_url("http://[::1]:8080").is_ok());
        assert!(validate_proxy_url("127.0.0.1:7890").is_err()); // no scheme
        assert!(validate_proxy_url("http://host").is_err()); // no port
        assert!(validate_proxy_url("http://:7890").is_err()); // no host
        assert!(validate_proxy_url("ftp://h:1").is_err()); // wrong scheme
    }

    #[test]
    fn proxy_env_modes() {
        let none = resolve_proxy_env("none", "");
        assert!(none.iter().any(|(k, v)| *k == "NO_PROXY" && v == "*"));
        assert!(none.iter().any(|(k, v)| *k == "HTTPS_PROXY" && v.is_empty()));

        let custom = resolve_proxy_env("custom", "http://127.0.0.1:7890");
        assert!(custom.iter().any(|(k, v)| *k == "HTTPS_PROXY" && v == "http://127.0.0.1:7890"));
        assert!(custom.iter().any(|(k, v)| *k == "NO_PROXY" && v.contains("127.0.0.1")));
    }

    #[test]
    fn scutil_proxy_parses_and_prefers_https() {
        // Real `scutil --proxy` shape (indented `Key : value` lines).
        let all = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 1087\n  HTTPSProxy : 127.0.0.1\n  SOCKSEnable : 1\n  SOCKSPort : 1087\n  SOCKSProxy : 127.0.0.1\n}";
        assert_eq!(parse_scutil_proxy(all).as_deref(), Some("http://127.0.0.1:1087"));
        let socks_only = "  SOCKSEnable : 1\n  SOCKSPort : 7890\n  SOCKSProxy : 10.0.0.2\n";
        assert_eq!(parse_scutil_proxy(socks_only).as_deref(), Some("socks5://10.0.0.2:7890"));
        let disabled = "  HTTPEnable : 0\n  HTTPPort : 1087\n  HTTPProxy : 127.0.0.1\n";
        assert_eq!(parse_scutil_proxy(disabled), None);
        assert_eq!(parse_scutil_proxy(""), None);
    }

    #[test]
    fn prune_removes_only_stale_skill_dirs() {
        let dst = std::env::temp_dir().join(format!("os-prune-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dst);
        for name in ["remote-compute", "hpc-slurm"] {
            fs::create_dir_all(dst.join(name)).unwrap();
            fs::write(dst.join(name).join("SKILL.md"), b"---\n").unwrap();
        }
        // A directory without a SKILL.md must never be touched.
        fs::create_dir_all(dst.join("notes")).unwrap();

        let mut bundled = std::collections::HashSet::new();
        bundled.insert(std::ffi::OsString::from("remote-compute"));
        prune_stale_skills(&dst, &bundled);

        assert!(dst.join("remote-compute").is_dir(), "bundled skill kept");
        assert!(!dst.join("hpc-slurm").exists(), "stale renamed skill removed");
        assert!(dst.join("notes").is_dir(), "non-skill dir left alone");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn prune_keeps_installed_user_skills() {
        // The reserved `user/` tree holds what the user installed — an app
        // upgrade (which prunes everything unbundled) must never delete it (#61).
        let dst = std::env::temp_dir().join(format!("os-prune-user-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dst);
        let installed = dst.join("user").join("my-skill");
        fs::create_dir_all(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), b"---\nname: my-skill\n---\n").unwrap();
        // A SKILL.md directly inside `user/` (not a skill dir of its own) too.
        fs::write(dst.join("user").join("SKILL.md"), b"---\n").unwrap();

        prune_stale_skills(&dst, &std::collections::HashSet::new());

        assert!(installed.join("SKILL.md").is_file(), "installed skill kept");
        let _ = fs::remove_dir_all(&dst);
    }

    #[test]
    fn skill_name_comes_from_frontmatter_and_is_safe() {
        assert_eq!(
            skill_name_from_markdown("---\nname: my-skill\ndescription: x\n---\n\nbody\n")
                .as_deref(),
            Some("my-skill"),
        );
        // Quoted, CRLF, and a leading BOM all still parse.
        assert_eq!(
            skill_name_from_markdown("\u{feff}---\r\nname: \"quoted_1\"\r\n---\r\n").as_deref(),
            Some("quoted_1"),
        );
        // Not a skill file, or a name that cannot be a directory.
        assert_eq!(skill_name_from_markdown("# just markdown\n"), None);
        assert_eq!(skill_name_from_markdown("---\ndescription: x\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: ../escape\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: sub/dir\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname: .hidden\n---\n"), None);
        assert_eq!(skill_name_from_markdown("---\nname:\n---\n"), None);
    }

    #[test]
    fn workspace_skill_dirs_lists_only_real_skills() {
        let ws = std::env::temp_dir().join(format!("os-ws-skills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let root = ws.join(".dsh").join("skills");
        fs::create_dir_all(root.join("installed")).unwrap();
        fs::write(root.join("installed").join("SKILL.md"), b"---\n").unwrap();
        fs::create_dir_all(root.join("half-written")).unwrap(); // no SKILL.md yet
        fs::write(root.join("loose.md"), b"---\n").unwrap();

        let found = workspace_skill_dirs(&ws);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].file_name().unwrap(), "installed");
        // A workspace with no .dsh/skills at all is simply empty.
        assert!(workspace_skill_dirs(&std::env::temp_dir().join("os-nope")).is_empty());
        let _ = fs::remove_dir_all(&ws);
    }

    #[cfg(unix)]
    #[test]
    fn tighten_private_makes_dir_and_secrets_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("os-private-{}", std::process::id()));
        let sub = dir.join("dsh");
        fs::create_dir_all(&sub).unwrap();
        let cfg = sub.join("dsh.jsonc");
        fs::write(&cfg, b"{\"apiKey\":\"secret\"}").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&cfg, fs::Permissions::from_mode(0o644)).unwrap();

        // The runtime root holds provider/connector keys (dsh.jsonc,
        // auth.json) — it must be unreadable to other users even when the
        // sidecar later rewrites files inside with a default umask.
        super::tighten_private(&dir);
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        super::tighten_private(&cfg);
        assert_eq!(fs::metadata(&cfg).unwrap().permissions().mode() & 0o777, 0o600);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn random_hex_is_csprng_shaped() {
        // 16 bytes → 32 hex chars, fresh per call — the shape the sidecar
        // password and the preview/Jupyter tokens rely on.
        let a = random_hex(16);
        let b = random_hex(16);
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two draws must differ");
    }

    #[test]
    fn removes_only_the_named_config_entry() {
        let cfg = r#"{"model":"a/b","provider":{"ollama":{"npm":"x"},"keep":{"npm":"y"}},"mcp":{"pw":{"type":"local"}}}"#;
        let out = remove_key_from_config(cfg, "provider", "ollama").unwrap();
        assert!(!out.contains("ollama"));
        assert!(out.contains("keep"));
        assert!(out.contains("\"model\": \"a/b\""));
        let out2 = remove_key_from_config(cfg, "mcp", "pw").unwrap();
        assert!(!out2.contains("\"pw\""));
        // Absent key and non-JSON input are errors, not silent no-ops.
        assert!(remove_key_from_config(cfg, "provider", "missing").is_err());
        assert!(remove_key_from_config("// jsonc comment\n{}", "provider", "x").is_err());
    }

    fn write(path: &std::path::Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn sync_replaces_bundled_and_keeps_user_skills() {
        let tmp = std::env::temp_dir().join(format!("skillsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        // Bundled pack: one skill with a nested reference file, plus a top-level
        // plain file (.commit) that must NOT be copied.
        write(&src.join("paper-writer/SKILL.md"), "v2");
        write(&src.join("paper-writer/references/guide.md"), "ref");
        write(&src.join(".commit"), "abc123");
        // A placeholder dir without SKILL.md must not be deployed.
        fs::create_dir_all(src.join("placeholder")).unwrap();

        // Existing workspace: a stale copy of the bundled skill (with a file the
        // new version no longer has) and a user-installed skill.
        write(&dst.join("paper-writer/SKILL.md"), "v1");
        write(&dst.join("paper-writer/obsolete.md"), "old");
        write(&dst.join("my-skill/SKILL.md"), "user");

        sync_skill_pack(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("paper-writer/SKILL.md")).unwrap(), "v2");
        assert_eq!(
            fs::read_to_string(dst.join("paper-writer/references/guide.md")).unwrap(),
            "ref"
        );
        assert!(!dst.join("paper-writer/obsolete.md").exists(), "stale file must be gone");
        assert_eq!(fs::read_to_string(dst.join("my-skill/SKILL.md")).unwrap(), "user");
        assert!(!dst.join(".commit").exists(), "top-level files are not skills");
        assert!(!dst.join("placeholder").exists(), "dirs without SKILL.md are not skills");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sync_creates_destination_when_missing() {
        let tmp = std::env::temp_dir().join(format!("skillsync-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        write(&src.join("literature-survey/SKILL.md"), "s");

        let dst = tmp.join("deep/nested/skills");
        sync_skill_pack(&src, &dst).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join("literature-survey/SKILL.md")).unwrap(),
            "s"
        );
        fs::remove_dir_all(&tmp).unwrap();
    }
}

/// Remove an entry from a map section of the app-private global dsh
/// config ("provider" or "mcp") and restart the sidecar (PATCH /global/config
/// cannot delete keys).
#[tauri::command(async)]
pub fn remove_config_entry(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    section: String,
    key: String,
) -> Result<(), String> {
    if !matches!(section.as_str(), "provider" | "mcp") {
        return Err(format!("section \"{section}\" is not removable"));
    }
    let dir = xdg_config_home(&app)?.join("dsh");
    // The server writes dsh.jsonc; older configs may be dsh.json.
    let path = ["dsh.jsonc", "dsh.json"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
        .ok_or("no global dsh config found")?;
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let out = remove_key_from_config(&text, &section, &key)?;
    std::fs::write(&path, out).map_err(|e| e.to_string())?;
    tighten_private(&path);

    restart_sidecar_if_running(&app, &state)?;
    Ok(())
}

/// Drop `key` from the config JSON's `section` map, erroring when the config
/// is not plain JSON or the key is absent.
fn remove_key_from_config(text: &str, section: &str, key: &str) -> Result<String, String> {
    let mut cfg: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("config is not plain JSON: {e}"))?;
    let removed = cfg
        .get_mut(section)
        .and_then(|p| p.as_object_mut())
        .map(|p| p.remove(key).is_some())
        .unwrap_or(false);
    if !removed {
        return Err(format!("\"{key}\" is not in the config's {section} section"));
    }
    serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())
}

/// The global memory file: one Markdown document the app seeds for every
/// conversation, in the app-private dsh home next to its skills.
fn global_memory_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dsh_home(app)?.join("MEMORY.md"))
}

/// Absolute path of a memory file, forward-slashed so the config stays
/// portable. `scope` is "global" (the profile file) or "project" (that
/// folder's own AGENTS.md — the file dsh loads for sessions inside it).
fn memory_file(app: &AppHandle, scope: &str, directory: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => global_memory_file(app),
        "project" => {
            let dir = directory.filter(|d| !d.is_empty()).ok_or("no project folder")?;
            Ok(PathBuf::from(dir).join(crate::dsh_config::PROJECT_MEMORY_FILE))
        }
        other => Err(format!("unknown memory scope \"{other}\"")),
    }
}

/// Read a memory layer. A file that was never written reads as empty — the
/// editor opens blank rather than erroring.
#[tauri::command]
pub fn read_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
) -> Result<String, String> {
    let path = memory_file(&app, &scope, directory.as_deref())?;
    Ok(std::fs::read_to_string(path).unwrap_or_default())
}

/// Replace a memory layer's contents. Writing an empty document deletes the
/// file, so "cleared" and "never set" stay the same state.
#[tauri::command]
pub fn write_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    let path = memory_file(&app, &scope, directory.as_deref())?;
    if text.trim().is_empty() {
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Append a block to a memory layer, keeping what is already there. This is
/// what "save this to memory" from a conversation does.
#[tauri::command]
pub fn append_memory(
    app: AppHandle,
    scope: String,
    directory: Option<String>,
    text: String,
) -> Result<(), String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let path = memory_file(&app, &scope, directory.as_deref())?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let mut out = existing.trim_end().to_string();
    if !out.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(trimmed);
    out.push('\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, out).map_err(|e| e.to_string())
}

/// Whether the memory layers are currently applied to conversations.
#[tauri::command]
pub fn get_memory_enabled(app: AppHandle) -> Result<bool, String> {
    let global = global_memory_file(&app)?.to_string_lossy().replace('\\', "/");
    let existing = std::fs::read_to_string(effective_config_file(&app)?).unwrap_or_default();
    Ok(crate::dsh_config::memory_enabled(&existing, &global))
}

/// Apply or stop applying the memory layers, restarting the sidecar so the
/// change takes effect (instructions are read when a session's context is built).
#[tauri::command(async)]
pub fn set_memory_enabled(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    enabled: bool,
) -> Result<(), String> {
    let global = global_memory_file(&app)?.to_string_lossy().replace('\\', "/");
    let path = effective_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let Some(updated) = crate::dsh_config::set_memory_enabled(&existing, &global, enabled)
    else {
        return Ok(()); // already in the requested state — no restart
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    tighten_private(&path);
    restart_sidecar_if_running(&app, &state)?;
    Ok(())
}

/// Per-agent model overrides as `{ agent: "provider/model" }`.
#[tauri::command]
pub fn get_agent_models(app: AppHandle) -> Result<serde_json::Value, String> {
    let existing = std::fs::read_to_string(effective_config_file(&app)?).unwrap_or_default();
    let map: serde_json::Map<String, serde_json::Value> =
        crate::dsh_config::agent_models(&existing)
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
    Ok(serde_json::Value::Object(map))
}

/// Per-agent reasoning-effort overrides as `{ agent: "high" }` (#71).
#[tauri::command]
pub fn get_agent_variants(app: AppHandle) -> Result<serde_json::Value, String> {
    let existing = std::fs::read_to_string(effective_config_file(&app)?).unwrap_or_default();
    let map: serde_json::Map<String, serde_json::Value> =
        crate::dsh_config::agent_variants(&existing)
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect();
    Ok(serde_json::Value::Object(map))
}

/// Persist one rewritten config and restart the sidecar, unless the rewrite is a
/// no-op. Shared by the per-agent model and effort writers.
fn write_agent_config(
    app: &AppHandle,
    state: &State<'_, RuntimeState>,
    rewrite: impl FnOnce(&str) -> String,
) -> Result<(), String> {
    let path = effective_config_file(app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let updated = rewrite(&existing);
    if updated == existing {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, updated).map_err(|e| e.to_string())?;
    tighten_private(&path);
    restart_sidecar_if_running(app, state)?;
    Ok(())
}

/// Pin one agent to its own model, or clear the override with an empty model.
/// Restarts the sidecar: agent definitions are built when it loads its config.
#[tauri::command(async)]
pub fn set_agent_model(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    agent: String,
    model: String,
) -> Result<(), String> {
    write_agent_config(&app, &state, |existing| {
        let want = if model.is_empty() { None } else { Some(model.as_str()) };
        crate::dsh_config::set_agent_model(existing, &agent, want)
    })
}

/// Pin one agent to a reasoning-effort variant, or clear it with an empty string.
/// Restarts the sidecar for the same reason `set_agent_model` does.
#[tauri::command(async)]
pub fn set_agent_variant(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    agent: String,
    variant: String,
) -> Result<(), String> {
    write_agent_config(&app, &state, |existing| {
        let want = if variant.is_empty() { None } else { Some(variant.as_str()) };
        crate::dsh_config::set_agent_variant(existing, &agent, want)
    })
}

/// The persisted proxy setting plus the proxy the sidecar would use right now.
#[tauri::command]
pub fn get_proxy_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    let (mode, url) = read_proxy_setting(&app);
    let effective = effective_proxy(&mode, &url);
    Ok(serde_json::json!({ "mode": mode, "url": url, "effective": effective }))
}

/// Persist the proxy setting ("system" | "custom" | "none", url for custom)
/// and restart the sidecar so its network env takes effect.
#[tauri::command(async)]
pub fn set_proxy_setting(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    mode: String,
    url: String,
) -> Result<String, String> {
    let line = match mode.as_str() {
        "system" => "system".to_string(),
        "none" => "none".to_string(),
        "custom" => {
            let url = url.trim();
            validate_proxy_url(url)?;
            format!("custom {url}")
        }
        other => return Err(format!("unknown proxy mode: {other}")),
    };
    let path = proxy_setting_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, line).map_err(|e| e.to_string())?;

    // The proxy environment only applies at spawn, so restart on change.
    Ok(restart_sidecar_if_running(&app, &state)?
        .unwrap_or_else(|| path.to_string_lossy().to_string()))
}

/// The persisted uv mirrors (empty string ⇒ use uv's default index/mirror).
#[tauri::command]
pub fn get_mirror_setting(app: AppHandle) -> Result<serde_json::Value, String> {
    let (pypi, python) = read_mirror_setting(&app);
    Ok(serde_json::json!({ "pypi": pypi, "python": python }))
}

/// Persist the uv mirrors. Blank fields clear that mirror. No sidecar restart:
/// only the next provisioning run (Jupyter / science MCP) reads them.
#[tauri::command]
pub fn set_mirror_setting(app: AppHandle, pypi: String, python: String) -> Result<(), String> {
    let (pypi, python) = (pypi.trim(), python.trim());
    let mut lines = Vec::new();
    if !pypi.is_empty() {
        validate_mirror_url(pypi)?;
        lines.push(format!("pypi {pypi}"));
    }
    if !python.is_empty() {
        validate_mirror_url(python)?;
        lines.push(format!("python {python}"));
    }
    let path = mirror_setting_file(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, lines.join("\n")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod export_tests {
    use super::safe_file_stem;

    #[test]
    fn a_title_can_never_become_a_path() {
        // Separators become dashes, so the result can only ever be a leaf name.
        assert_eq!(
            safe_file_stem("../../.ssh/authorized_keys", "x"),
            "..-..-.ssh-authorized_keys"
        );
        assert_eq!(safe_file_stem("C:\\Windows\\System32", "x"), "C--Windows-System32");
    }

    #[test]
    fn keeps_ordinary_titles_readable_including_non_latin() {
        assert_eq!(safe_file_stem("Spike sorting — pass 2", "x"), "Spike sorting — pass 2");
        assert_eq!(safe_file_stem("脑机接口趋势分析", "x"), "脑机接口趋势分析");
    }

    #[test]
    fn falls_back_when_a_title_leaves_nothing_usable() {
        assert_eq!(safe_file_stem("   ", "conversation"), "conversation");
        // Nothing but separators still yields a harmless leaf name.
        assert_eq!(safe_file_stem("///", "conversation"), "---");
        // Windows rejects a trailing dot.
        assert_eq!(safe_file_stem("results.", "x"), "results");
    }

    #[test]
    fn sidesteps_windows_device_names() {
        assert_eq!(safe_file_stem("CON", "x"), "CON-");
        assert_eq!(safe_file_stem("nul", "x"), "nul-");
        assert_eq!(safe_file_stem("console", "x"), "console");
    }

    #[test]
    fn caps_the_length_so_the_filesystem_accepts_it() {
        let long = "n".repeat(500);
        assert_eq!(safe_file_stem(&long, "x").chars().count(), 80);
    }
}
