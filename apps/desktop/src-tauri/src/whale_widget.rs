//! Optional DeepSeek balance and usage widget backed by a bundled dsh plugin.
//!
//! The plugin owns DeepSeek credential access and usage accounting. DeepLab
//! only mounts it, proxies its JSON surface, and stores the opt-in flag.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::runtime::{self, RuntimeState};

const STATE_VERSION: u32 = 1;
const STATE_FILENAME: &str = "whale-widget.json";
const PLUGIN_VERSION: &str = "0.2.10";
const UPSTREAM_COMMIT: &str = "4448c61db7d180c4c307aa3fa734db7c8507658d";
pub(crate) const WINDOW_LABEL: &str = "whale-widget";
const POINTER_POLL_INTERVAL: Duration = Duration::from_millis(16);
const POINTER_EXIT_GRACE: Duration = Duration::from_millis(150);
const HIT_REPORT_TTL: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HitRegion {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}

impl HitRegion {
    fn is_valid(self) -> bool {
        self.left.is_finite()
            && self.top.is_finite()
            && self.right.is_finite()
            && self.bottom.is_finite()
            && self.right > self.left
            && self.bottom > self.top
    }

    fn contains(self, x: f64, y: f64) -> bool {
        x >= self.left && x <= self.right && y >= self.top && y <= self.bottom
    }
}

#[derive(Debug, Deserialize)]
struct HitReport {
    regions: Vec<HitRegion>,
    dragging: bool,
}

#[derive(Default)]
struct HitState {
    regions: Vec<HitRegion>,
    dragging: bool,
    updated_at: Option<Instant>,
}

#[derive(Default)]
pub struct WhaleWindowState {
    hit: Mutex<HitState>,
    pointer_router_running: AtomicBool,
}

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
    reset_hit_regions(app);
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

fn reset_hit_regions(app: &AppHandle) {
    let state = app.state::<WhaleWindowState>();
    *state.hit.lock().unwrap_or_else(|error| error.into_inner()) = HitState::default();
}

pub(crate) fn update_hit_regions(app: &AppHandle, body: &[u8]) -> Result<(), String> {
    let mut report: HitReport =
        serde_json::from_slice(body).map_err(|error| format!("invalid whale hit report: {error}"))?;
    if report.regions.len() > 8 || report.regions.iter().any(|region| !region.is_valid()) {
        return Err("invalid whale hit regions".to_string());
    }
    let state = app.state::<WhaleWindowState>();
    let mut hit = state.hit.lock().unwrap_or_else(|error| error.into_inner());
    hit.regions = std::mem::take(&mut report.regions);
    hit.dragging = report.dragging;
    hit.updated_at = Some(Instant::now());
    Ok(())
}

fn start_pointer_router(app: &AppHandle) {
    let state = app.state::<WhaleWindowState>();
    if state.pointer_router_running.swap(true, Ordering::AcqRel) {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        let mut ignoring_cursor = false;
        let mut last_inside = None;
        loop {
            let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
                break;
            };
            let now = Instant::now();
            let local_cursor = window
                .cursor_position()
                .ok()
                .zip(window.outer_position().ok())
                .zip(window.scale_factor().ok())
                .map(|((cursor, origin), scale)| {
                    (
                        (cursor.x - f64::from(origin.x)) / scale,
                        (cursor.y - f64::from(origin.y)) / scale,
                    )
                });
            let (inside, dragging) = {
                let state = app.state::<WhaleWindowState>();
                let hit = state.hit.lock().unwrap_or_else(|error| error.into_inner());
                let fresh = hit
                    .updated_at
                    .is_some_and(|updated_at| now.duration_since(updated_at) <= HIT_REPORT_TTL);
                let inside = fresh
                    && local_cursor.is_some_and(|(x, y)| {
                        hit.regions.iter().any(|region| region.contains(x, y))
                    });
                (inside, fresh && hit.dragging)
            };
            if inside || dragging {
                last_inside = Some(now);
            }
            let capture_cursor = inside
                || dragging
                || last_inside.is_some_and(|last| now.duration_since(last) <= POINTER_EXIT_GRACE);
            if capture_cursor == ignoring_cursor {
                ignoring_cursor = !capture_cursor;
                let _ = window.set_ignore_cursor_events(ignoring_cursor);
            }
            std::thread::sleep(POINTER_POLL_INTERVAL);
        }
        app.state::<WhaleWindowState>()
            .pointer_router_running
            .store(false, Ordering::Release);
    });
}

fn fit_window_to_work_area(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|main| main.current_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .ok_or_else(|| "could not determine the whale widget display".to_string())?;
    let area = monitor.work_area();
    window
        .set_position(PhysicalPosition::new(area.position.x, area.position.y))
        .map_err(|error| error.to_string())?;
    window
        .set_size(PhysicalSize::new(area.size.width, area.size.height))
        .map_err(|error| error.to_string())?;
    Ok(())
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
        reset_hit_regions(&app);
        window.navigate(url).map_err(|error| error.to_string())?;
        fit_window_to_work_area(&app, &window)?;
        window
            .set_ignore_cursor_events(true)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        start_pointer_router(&app);
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(&app, WINDOW_LABEL, WebviewUrl::External(url))
        .title("DeepLab Whale")
        .inner_size(500.0, 500.0)
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
    fit_window_to_work_area(&app, &window)?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    start_pointer_router(&app);
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

    #[test]
    fn hit_regions_reject_invalid_geometry_and_test_bounds() {
        let region = HitRegion {
            left: 10.0,
            top: 20.0,
            right: 110.0,
            bottom: 120.0,
        };
        assert!(region.is_valid());
        assert!(region.contains(10.0, 120.0));
        assert!(!region.contains(9.0, 120.0));
        assert!(!HitRegion { right: 10.0, ..region }.is_valid());
    }
}
