//! App-owned MCP composition for the bundled `dsh --profile web` runtime.
//!
//! DeepLab keeps its connector inventory in a small JSON state file and renders
//! a dedicated Cordis patch from it. The patch is passed to dsh with `--patch`,
//! so it never rewrites the user's profile or home-level patch layers.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

use crate::runtime::{self, RuntimeState};

const STATE_VERSION: u32 = 1;
const STATE_FILENAME: &str = "dsh-mcp.json";
const PATCH_FILENAME: &str = "dsh-mcp.patch.yml";
const ROW_PREFIX: &str = "deeplab-mcp-";
const MCP_PLUGIN: &str = "@deepseek-ai/dsh-mcp-client";
const CREDENTIAL_REFS_ENV: &str = "DEEPLAB_MCP_CREDENTIAL_REFS";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpConfig {
    Local {
        command: Vec<String>,
        #[serde(default = "default_enabled")]
        enabled: bool,
    },
    Remote {
        url: String,
        #[serde(default = "default_enabled")]
        enabled: bool,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct ManagedServer {
    #[serde(flatten)]
    config: McpConfig,
    #[serde(default, rename = "credentialRefs")]
    credential_refs: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StateFile {
    version: u32,
    servers: BTreeMap<String, ManagedServer>,
}

impl Default for StateFile {
    fn default() -> Self {
        Self {
            version: STATE_VERSION,
            servers: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    name: String,
    status: String,
    config: McpConfig,
}

fn default_enabled() -> bool {
    true
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime::runtime_root(app)?.join(STATE_FILENAME))
}

pub(crate) fn patch_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime::runtime_root(app)?.join(PATCH_FILENAME))
}

fn read_state(path: &Path) -> Result<StateFile, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(StateFile::default())
        }
        Err(error) => return Err(error.to_string()),
    };
    let state: StateFile =
        serde_json::from_str(&text).map_err(|e| format!("MCP state parse: {e}"))?;
    if state.version != STATE_VERSION {
        return Err(format!(
            "unsupported MCP state version {}; expected {STATE_VERSION}",
            state.version
        ));
    }
    Ok(state)
}

fn write_file(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        runtime::tighten_private(parent);
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    if std::fs::rename(&tmp, path).is_err() {
        std::fs::write(path, body).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
    }
    runtime::tighten_private(path);
    Ok(())
}

fn write_state(path: &Path, state: &StateFile) -> Result<(), String> {
    let body = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_file(path, &body)
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_credential_ref(value: &str) -> bool {
    let mut bytes = value.bytes();
    matches!(
        bytes.next(),
        Some(b'A'..=b'Z') | Some(b'a'..=b'z') | Some(b'_')
    ) && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn validate(name: &str, config: &McpConfig, credential_refs: &[String]) -> Result<(), String> {
    if !valid_name(name) {
        return Err(
            "MCP server name must be 1-32 ASCII letters, digits, underscores, or hyphens".into(),
        );
    }
    let mut unique = BTreeSet::new();
    for reference in credential_refs {
        if !valid_credential_ref(reference) {
            return Err(format!("invalid MCP credential reference {reference:?}"));
        }
        if !unique.insert(reference) {
            return Err(format!("duplicate MCP credential reference {reference:?}"));
        }
    }
    match config {
        McpConfig::Local { command, .. } => {
            if command.is_empty()
                || command
                    .iter()
                    .any(|part| part.is_empty() || part.contains('\0'))
            {
                return Err("local MCP command must contain non-empty arguments".into());
            }
        }
        McpConfig::Remote { url, .. } => {
            if !(url.starts_with("http://") || url.starts_with("https://"))
                || url.chars().any(char::is_whitespace)
            {
                return Err("remote MCP URL must be an HTTP(S) URL without whitespace".into());
            }
            if !credential_refs.is_empty() {
                return Err("credential-backed remote MCP headers are not supported yet".into());
            }
        }
    }
    Ok(())
}

fn orphaned_refs(
    candidates: impl IntoIterator<Item = String>,
    servers: &BTreeMap<String, ManagedServer>,
) -> Vec<String> {
    let still_used: BTreeSet<&str> = servers
        .values()
        .flat_map(|server| server.credential_refs.iter().map(String::as_str))
        .collect();
    candidates
        .into_iter()
        .filter(|reference| !still_used.contains(reference.as_str()))
        .collect()
}

fn render_patch(
    state: &StateFile,
    node: &str,
    wrapper: &Path,
    dsh_home: &Path,
) -> Result<String, String> {
    let mut entries = Vec::new();
    for (name, server) in &state.servers {
        validate(name, &server.config, &server.credential_refs)?;
        let (enabled, config) = match &server.config {
            McpConfig::Local { command, enabled } => {
                let (program, args, env) = if server.credential_refs.is_empty() {
                    (command[0].clone(), command[1..].to_vec(), None)
                } else {
                    let mut args = vec![wrapper.to_string_lossy().to_string(), "--".into()];
                    args.extend(command.iter().cloned());
                    let refs = serde_json::to_string(&server.credential_refs)
                        .map_err(|e| e.to_string())?;
                    (
                        node.to_string(),
                        args,
                        Some(json!({
                            "DSH_HOME": dsh_home.to_string_lossy(),
                            CREDENTIAL_REFS_ENV: refs,
                        })),
                    )
                };
                let mut config = json!({
                    "serverName": name,
                    "transport": "stdio",
                    "command": program,
                    "args": args,
                });
                if let Some(env) = env {
                    config["env"] = env;
                }
                (*enabled, config)
            }
            McpConfig::Remote { url, enabled } => (
                *enabled,
                json!({
                    "serverName": name,
                    "transport": "streamable-http",
                    "url": url,
                }),
            ),
        };
        let mut entry = json!({
            "id": format!("{ROW_PREFIX}{name}"),
            "name": MCP_PLUGIN,
            "config": config,
        });
        if !enabled {
            entry["disabled"] = Value::Bool(true);
        }
        entries.push(entry);
    }
    if entries.is_empty() {
        return Ok("[]\n".to_string());
    }
    serde_json::to_string_pretty(&json!([{ "insert": entries }]))
        .map(|body| format!("{body}\n"))
        .map_err(|e| e.to_string())
}

fn launch_parts(app: &AppHandle) -> Result<(String, PathBuf, PathBuf), String> {
    let dsh_dir = app
        .path()
        .resolve("dsh", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("dsh resource not found: {e}"))?;
    let node = std::env::var("DEEPLAB_NODE").unwrap_or_else(|_| "node".to_string());
    Ok((
        node,
        dsh_dir.join("mcp-credential-wrapper.mjs"),
        runtime::dsh_home(app)?,
    ))
}

pub(crate) fn refresh_patch(app: &AppHandle) -> Result<PathBuf, String> {
    let state = read_state(&state_path(app)?)?;
    let (node, wrapper, dsh_home) = launch_parts(app)?;
    let path = patch_path(app)?;
    let rendered = render_patch(&state, &node, &wrapper, &dsh_home)?;
    let mut patch: Value = serde_json::from_str(&rendered).map_err(|e| e.to_string())?;
    if let Some(entry) = crate::whale_widget::patch_entry(app)? {
        let layers = patch
            .as_array_mut()
            .ok_or_else(|| "generated dsh patch is not an array".to_string())?;
        if layers.is_empty() {
            layers.push(json!({ "insert": [entry] }));
        } else {
            layers[0]["insert"]
                .as_array_mut()
                .ok_or_else(|| "generated dsh patch insert is not an array".to_string())?
                .push(entry);
        }
    }
    let body = serde_json::to_string_pretty(&patch)
        .map(|body| format!("{body}\n"))
        .map_err(|e| e.to_string())?;
    write_file(&path, &body)?;
    Ok(path)
}

#[tauri::command]
pub fn list_dsh_mcp_servers(app: AppHandle) -> Result<Vec<McpServer>, String> {
    let state = read_state(&state_path(&app)?)?;
    Ok(state
        .servers
        .into_iter()
        .map(|(name, server)| {
            let enabled = match &server.config {
                McpConfig::Local { enabled, .. } | McpConfig::Remote { enabled, .. } => *enabled,
            };
            McpServer {
                name,
                status: if enabled { "configured" } else { "disabled" }.to_string(),
                config: server.config,
            }
        })
        .collect())
}

#[tauri::command(async)]
pub fn upsert_dsh_mcp_server(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    name: String,
    config: McpConfig,
    credential_refs: Vec<String>,
) -> Result<Vec<String>, String> {
    validate(&name, &config, &credential_refs)?;
    let path = state_path(&app)?;
    let mut inventory = read_state(&path)?;
    let previous = inventory.servers.insert(
        name,
        ManagedServer {
            config,
            credential_refs,
        },
    );
    let orphaned = orphaned_refs(
        previous
            .into_iter()
            .flat_map(|server| server.credential_refs),
        &inventory.servers,
    );
    write_state(&path, &inventory)?;
    refresh_patch(&app)?;
    runtime::restart_sidecar_if_running(&app, &state)?;
    Ok(orphaned)
}

#[tauri::command(async)]
pub fn remove_dsh_mcp_server(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    name: String,
) -> Result<Vec<String>, String> {
    let path = state_path(&app)?;
    let mut inventory = read_state(&path)?;
    let removed = inventory
        .servers
        .remove(&name)
        .ok_or_else(|| format!("MCP server {name:?} is not configured"))?;
    let orphaned = orphaned_refs(removed.credential_refs, &inventory.servers);
    write_state(&path, &inventory)?;
    refresh_patch(&app)?;
    runtime::restart_sidecar_if_running(&app, &state)?;
    Ok(orphaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_direct_and_credential_wrapped_stdio_entries() {
        let mut state = StateFile::default();
        state.servers.insert(
            "papers".into(),
            ManagedServer {
                config: McpConfig::Local {
                    command: vec!["python".into(), "-m".into(), "papers".into()],
                    enabled: true,
                },
                credential_refs: vec![],
            },
        );
        state.servers.insert(
            "jupyter".into(),
            ManagedServer {
                config: McpConfig::Local {
                    command: vec!["jupyter-mcp-server".into()],
                    enabled: true,
                },
                credential_refs: vec!["JUPYTER_URL".into(), "JUPYTER_TOKEN".into()],
            },
        );

        let patch = render_patch(
            &state,
            "node",
            Path::new("/app/mcp-credential-wrapper.mjs"),
            Path::new("/private/dsh"),
        )
        .unwrap();
        let value: Value = serde_json::from_str(&patch).unwrap();
        let entries = value[0]["insert"].as_array().unwrap();
        assert_eq!(entries[1]["config"]["command"], "python");
        assert_eq!(entries[1]["config"]["args"], json!(["-m", "papers"]));
        assert_eq!(entries[0]["config"]["command"], "node");
        assert_eq!(
            entries[0]["config"]["env"][CREDENTIAL_REFS_ENV],
            "[\"JUPYTER_URL\",\"JUPYTER_TOKEN\"]"
        );
        assert!(!patch.contains("token-value"));
    }

    #[test]
    fn rejects_unsafe_names_commands_and_urls() {
        assert!(validate(
            "bad name",
            &McpConfig::Local {
                command: vec!["python".into()],
                enabled: true,
            },
            &[],
        )
        .is_err());
        assert!(validate(
            "empty",
            &McpConfig::Local {
                command: vec![],
                enabled: true,
            },
            &[],
        )
        .is_err());
        assert!(validate(
            "remote",
            &McpConfig::Remote {
                url: "file:///tmp/mcp".into(),
                enabled: true,
            },
            &[],
        )
        .is_err());
    }

    #[test]
    fn empty_inventory_is_a_valid_yaml_json_patch() {
        assert_eq!(
            render_patch(
                &StateFile::default(),
                "node",
                Path::new("wrapper.mjs"),
                Path::new("dsh-home"),
            )
            .unwrap(),
            "[]\n"
        );
    }

    #[test]
    fn cleans_only_credentials_no_other_server_still_uses() {
        let mut servers = BTreeMap::new();
        servers.insert(
            "second".into(),
            ManagedServer {
                config: McpConfig::Local {
                    command: vec!["server".into()],
                    enabled: true,
                },
                credential_refs: vec!["SHARED_KEY".into()],
            },
        );

        assert_eq!(
            orphaned_refs(vec!["OLD_KEY".into(), "SHARED_KEY".into()], &servers),
            vec!["OLD_KEY"]
        );
    }
}
