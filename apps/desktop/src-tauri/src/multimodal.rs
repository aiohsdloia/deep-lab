// The user's configured multimodal model choices (image understanding + image
// generation), persisted next to the sidecar's config so the bundled
// `image-tools` skill can call those models directly even when the session's
// main model has no vision. The app owns this file (Settings → Models); the
// skill only reads it. Stored in the app-private profile — never the workspace.
use std::path::PathBuf;
use tauri::AppHandle;

use crate::runtime::xdg_config_home;

#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct MultimodalModels {
    /// `provider/model` key of the image-understanding model, or null for the
    /// skill's automatic vision-model fallback.
    #[serde(default)]
    pub vision: Option<String>,
    /// `provider/model` key of the image-generation model, or null for the
    /// skill's default (zhipu/cogview-3-flash when that provider is present).
    #[serde(default)]
    pub generate: Option<String>,
}

fn multimodal_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(xdg_config_home(app)?.join("dsh").join("multimodal.json"))
}

pub(crate) fn read_multimodal(app: &AppHandle) -> Result<MultimodalModels, String> {
    let path = multimodal_path(app)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("multimodal config parse: {e}"))
        }
        Err(_) => Ok(MultimodalModels::default()),
    }
}

/// Persist the configured image-understanding / image-generation model keys.
/// Written atomically (temp file + rename) so the skill never reads a partial
/// file while a settings edit races a probe.
#[tauri::command]
pub fn set_multimodal_models(
    app: AppHandle,
    vision: Option<String>,
    generate: Option<String>,
) -> Result<(), String> {
    let path = multimodal_path(&app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string(&MultimodalModels { vision, generate })
        .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| e.to_string())?;
    if std::fs::rename(&tmp, &path).is_err() {
        std::fs::write(&path, &body).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
    }
    Ok(())
}

#[tauri::command]
pub fn multimodal_models(app: AppHandle) -> Result<MultimodalModels, String> {
    read_multimodal(&app)
}

#[cfg(test)]
mod tests {
    use super::MultimodalModels;

    #[test]
    fn roundtrips_optional_fields() {
        let m = MultimodalModels { vision: Some("zhipu/glm-4.6v-flash".into()), generate: None };
        let json = serde_json::to_string(&m).unwrap();
        let back: MultimodalModels = serde_json::from_str(&json).unwrap();
        assert_eq!(back.vision.as_deref(), Some("zhipu/glm-4.6v-flash"));
        assert!(back.generate.is_none());
        // Absent keys default to None (a file written before generate existed).
        let old: MultimodalModels = serde_json::from_str(r#"{"vision":null}"#).unwrap();
        assert!(old.generate.is_none());
    }
}
