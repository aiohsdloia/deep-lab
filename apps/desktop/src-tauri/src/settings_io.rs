//! One-click export/import of the user's portable settings: custom model
//! providers (the OpenCode global config's `provider` map) and custom remote
//! compute servers (`<base workspace>/.openlab/compute.json`). The app
//! menu's File → Export Settings / Import Settings items drive these.
//!
//! The export is a single JSON file. It deliberately includes the custom
//! providers' API keys (they cannot be reconstructed from an id alone), so the
//! file must be treated as a secret. Import MERGES into the current settings —
//! incoming providers replace same-id entries, incoming machines replace
//! same-host entries; everything else is preserved.

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::compute;
use crate::runtime;

const SETTINGS_SCHEMA: &str = "ai4s-settings";
const SETTINGS_VERSION: u32 = 2;
const DEFAULT_FILE_NAME: &str = "openlab-settings.json";

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The `provider` map currently in the OpenCode global config ({} when absent).
fn read_providers(app: &AppHandle) -> Result<serde_json::Value, String> {
    let path = runtime::effective_config_file(app)?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    if text.trim().is_empty() {
        return Ok(serde_json::json!({}));
    }
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("OpenCode config parse: {e}"))?;
    Ok(v.get("provider").cloned().unwrap_or_else(|| serde_json::json!({})))
}

/// Gather custom providers + remote machines and write them to a file the user
/// picks via the native save dialog. Returns the written path, or None when
/// the user cancelled. Async: the dialog must run on the main thread — the
/// `blocking_*` variant deadlocks the desktop (white-screen freeze) on macOS.
#[tauri::command]
pub async fn export_settings(app: AppHandle) -> Result<Option<String>, String> {
    let providers = read_providers(&app)?;
    let machines = compute::load_machines(&app)?;
    let payload = serde_json::json!({
        "schema": SETTINGS_SCHEMA,
        "version": SETTINGS_VERSION,
        "exportedAt": unix_now(),
        "providers": providers,
        "compute": { "machines": serde_json::to_value(&machines).map_err(|e| e.to_string())? },
    });
    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    // Bridge the plugin's callback-based dialog into an awaitable future — the
    // `blocking_*` variant deadlocks the desktop on macOS (File → Export… froze).
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_file_name(DEFAULT_FILE_NAME).save_file(move |choice| {
        let _ = tx.send(choice);
    });
    let Some(choice) = rx.await.map_err(|_| "save dialog closed".to_string())? else {
        return Ok(None); // user cancelled
    };
    let path = choice.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Merge `incoming` providers (from an import file) into the OpenCode global
/// config, replacing same-id entries and keeping everything else.
fn merge_providers_into_config(app: &AppHandle, incoming: &serde_json::Value) -> Result<(), String> {
    let path = runtime::effective_config_file(app)?;
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut root: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).map_err(|e| format!("OpenCode config parse: {e}"))?
    };
    let obj = root.as_object_mut().ok_or("OpenCode config is not an object")?;
    let providers = obj.entry("provider").or_insert_with(|| serde_json::json!({}));
    let prov = providers.as_object_mut().ok_or("config.provider is not an object")?;
    if let Some(map) = incoming.as_object() {
        for (id, entry) in map {
            prov.insert(id.clone(), entry.clone());
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())?;
    runtime::tighten_private(&path);
    Ok(())
}

/// Merge `incoming` machines into the canonical compute.json (replace by host).
fn merge_machines(app: &AppHandle, incoming: &[compute::Machine]) -> Result<(), String> {
    let mut machines = compute::load_machines(app)?;
    for m in incoming {
        if let Some(existing) = machines.iter_mut().find(|x| x.host == m.host) {
            *existing = m.clone();
        } else {
            machines.push(m.clone());
        }
    }
    compute::save_machines(app, &machines)?;
    compute::materialize_active(app);
    Ok(())
}

/// Read one settings file via the native open dialog, merge its contents into
/// the current settings, and return a short summary of what was imported.
#[tauri::command]
pub async fn import_settings(app: AppHandle) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.map_err(|_| "open dialog closed".to_string())? else {
        return Ok("cancelled".into());
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let payload: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("settings parse: {e}"))?;
    if payload.get("schema").and_then(|s| s.as_str()) != Some(SETTINGS_SCHEMA) {
        return Err("not an Open Lab settings export".into());
    }

    let mut n_providers = 0usize;
    if let Some(incoming) = payload.get("providers") {
        if let Some(map) = incoming.as_object() {
            n_providers = map.len();
            merge_providers_into_config(&app, incoming)?;
        }
    }

    let mut n_machines = 0usize;
    if let Some(machines_val) = payload.get("compute").and_then(|c| c.get("machines")) {
        let machines: Vec<compute::Machine> = serde_json::from_value(machines_val.clone())
            .map_err(|e| format!("compute parse: {e}"))?;
        n_machines = machines.len();
        merge_machines(&app, &machines)?;
    }

    // A running sidecar does not hot-reload config edits — bounce it so the
    // imported providers take effect immediately. Machines are read from disk
    // by the agent on each run, so they need no restart.
    if n_providers > 0 {
        restart_if_running(&app)?;
    }

    Ok(format!("{n_providers} providers, {n_machines} machines"))
}

/// Restart the bundled OpenCode only if it is currently running.
fn restart_if_running(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<runtime::RuntimeState>();
    let _ = runtime::restart_sidecar_if_running(app, state.inner())?;
    Ok(())
}
