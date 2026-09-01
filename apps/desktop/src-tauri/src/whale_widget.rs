//! Optional DeepSeek balance and usage widget backed by a bundled dsh plugin.
//!
//! The plugin owns DeepSeek credential access and usage accounting. DeepLab
//! only mounts it, proxies its JSON surface, and stores the opt-in flag.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindowBuilder};

use crate::runtime::{self, RuntimeState};

const STATE_VERSION: u32 = 1;
const STATE_FILENAME: &str = "whale-widget.json";
const PLUGIN_VERSION: &str = "0.2.10";
const UPSTREAM_COMMIT: &str = "4448c61db7d180c4c307aa3fa734db7c8507658d";
pub(crate) const WINDOW_LABEL: &str = "whale-widget";
const WINDOW_SIZE: f64 = 500.0;
const WINDOW_MARGIN: i32 = 24;

#[derive(Debug, Deserialize, Serialize)]
struct WidgetState {
    version: u32,
    enabled: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetStatus {
    enabled: bool,
    plugin_version: &'static str,
    upstream_commit: &'static str,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime::runtime_root(app)?.join(STATE_FILENAME))
}

fn read_state(path: &Path) -> Result<WidgetState, String> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WidgetState {
                version: STATE_VERSION,
                enabled: false,
            });
        }
        Err(error) => return Err(error.to_string()),
    };
    let state: WidgetState =
        serde_json::from_str(&text).map_err(|error| format!("widget state parse: {error}"))?;
    if state.version != STATE_VERSION {
        return Err(format!(
            "unsupported widget state version {}; expected {STATE_VERSION}",
            state.version
        ));
    }
    Ok(state)
}

fn write_state(path: &Path, state: &WidgetState) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "widget state has no parent directory".to_string())?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let body = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("tmp");
    std::fs::write(&temporary, body).map_err(|error| error.to_string())?;
    if std::fs::rename(&temporary, path).is_err() {
        std::fs::write(
            path,
            serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let _ = std::fs::remove_file(&temporary);
    }
    runtime::tighten_private(path);
    Ok(())
}

pub(crate) fn enabled(app: &AppHandle) -> Result<bool, String> {
    Ok(read_state(&state_path(app)?)?.enabled)
}

pub(crate) fn status(app: &AppHandle) -> Result<WidgetStatus, String> {
    Ok(WidgetStatus {
        enabled: enabled(app)?,
        plugin_version: PLUGIN_VERSION,
        upstream_commit: UPSTREAM_COMMIT,
    })
}

/// Cordis accepts an absolute module path. This keeps the vendored package out
/// of dsh's mutable profile and avoids a network install at first enable.
pub(crate) fn patch_entry(app: &AppHandle) -> Result<Option<Value>, String> {
    if !enabled(app)? {
        return Ok(None);
    }
    let plugin = app
        .path()
        .resolve(
            "dsh-plugins/whale-widget/lib/index.js",
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| format!("whale widget resource not found: {error}"))?;
    if !plugin.is_file() {
        return Err(format!(
            "whale widget entry point is missing: {}",
            plugin.display()
        ));
    }
    let specifier = tauri::Url::from_file_path(&plugin).map_err(|_| {
        format!(
            "could not convert plugin path to a file URL: {}",
            plugin.display()
        )
    })?;
    Ok(Some(json!({
        "id": "deeplab-whale-widget",
        "name": specifier.as_str(),
    })))
}

#[tauri::command]
pub fn whale_widget_status(app: AppHandle) -> Result<WidgetStatus, String> {
    status(&app)
}

pub(crate) fn close_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

#[tauri::command]
pub async fn show_whale_widget_window(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<(), String> {
    if !enabled(&app)? {
        return Err("whale widget is disabled".into());
    }
    let (gateway_url, token) = runtime::gateway_access(&state)
        .ok_or_else(|| "runtime gateway is not ready".to_string())?;
    let url = format!(
        "{}/__deeplab/whale/{}/host.html",
        gateway_url.trim_end_matches('/'),
        token
    )
    .parse()
    .map_err(|error| format!("invalid whale widget URL: {error}"))?;
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.remove_menu();
        window.navigate(url).map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("DeepLab Whale")
        .inner_size(WINDOW_SIZE, WINDOW_SIZE)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|error| format!("could not create whale widget window: {error}"))?;

    window
        .remove_menu()
        .map_err(|error| format!("could not remove whale widget menu: {error}"))?;

    if let Ok(Some(monitor)) = window.current_monitor() {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let scale = monitor.scale_factor();
        let physical_size = (WINDOW_SIZE * scale).round() as i32;
        let x = monitor_position.x + monitor_size.width as i32 - physical_size - WINDOW_MARGIN;
        let y = monitor_position.y + monitor_size.height as i32 - physical_size - WINDOW_MARGIN;
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
    window.show().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command(async)]
pub fn set_whale_widget_enabled(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    enabled: bool,
) -> Result<(), String> {
    let path = state_path(&app)?;
    let current = read_state(&path)?;
    if current.enabled == enabled {
        if !enabled {
            close_window(&app);
        }
        return Ok(());
    }
    write_state(
        &path,
        &WidgetState {
            version: STATE_VERSION,
            enabled,
        },
    )?;
    crate::dsh_mcp::refresh_patch(&app)?;
    runtime::restart_sidecar_if_running(&app, &state)?;
    if !enabled {
        close_window(&app);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_defaults_off_and_round_trips() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "deeplab-whale-state-{}-{}.json",
            std::process::id(),
            unique
        ));
        let _ = std::fs::remove_file(&path);
        assert!(!read_state(&path).unwrap().enabled);
        write_state(
            &path,
            &WidgetState {
                version: STATE_VERSION,
                enabled: true,
            },
        )
        .unwrap();
        assert!(read_state(&path).unwrap().enabled);
        let _ = std::fs::remove_file(path);
    }
}
