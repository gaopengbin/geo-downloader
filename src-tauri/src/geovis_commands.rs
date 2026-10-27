//! Desktop IPC wrappers; provider logic stays usable by the shared headless engine.
use crate::geovis::{self, GeovisStatus};

#[tauri::command]
pub fn geovis_set_token(token: String) -> Result<(), String> { geovis::geovis_set_token(token) }

#[tauri::command]
pub fn geovis_delete_token() -> Result<(), String> { geovis::geovis_delete_token() }

#[tauri::command]
pub fn geovis_status() -> Result<GeovisStatus, String> { geovis::geovis_status() }

#[tauri::command]
pub async fn geovis_probe_access() -> Result<GeovisStatus, String> { geovis::geovis_probe_access().await }

#[tauri::command]
pub async fn geovis_preview_tile(source_key: String, z: u8, x: u32, y: u32) -> Result<String, String> {
    geovis::geovis_preview_tile(source_key, z, x, y).await
}
