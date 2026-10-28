//! GeoD's headless engine. These modules intentionally share their source with
//! the desktop app while the public job API is developed, keeping download,
//! tile math and export fixes in one place without importing Tauri.

#[path = "../../../src-tauri/src/config.rs"]
pub mod config;
#[path = "../../../src-tauri/src/tile.rs"]
pub mod tile;
#[path = "../../../src-tauri/src/merger.rs"]
pub mod merger;
#[path = "../../../src-tauri/src/overlay.rs"]
pub mod overlay;
#[path = "../../../src-tauri/src/tile_crop.rs"]
pub mod tile_crop;
#[path = "../../../src-tauri/src/exporter.rs"]
pub mod exporter;
#[path = "../../../src-tauri/src/streaming_tiff.rs"]
pub mod streaming_tiff;
#[path = "../../../src-tauri/src/streaming_raster.rs"]
pub mod streaming_raster;
#[path = "../../../src-tauri/src/pyramid.rs"]
pub mod pyramid;
#[path = "../../../src-tauri/src/tile_pack.rs"]
pub mod tile_pack;
#[path = "../../../src-tauri/src/downloader.rs"]
pub mod downloader;
#[path = "../../../src-tauri/src/tianditu_tokens.rs"]
pub mod tianditu_tokens;
#[path = "../../../src-tauri/src/tile_policy.rs"]
pub mod tile_policy;
#[path = "../../../src-tauri/src/tile_payload.rs"]
pub mod tile_payload;
#[path = "../../../src-tauri/src/source_analyzer.rs"]
pub mod source_analyzer;
#[path = "../../../src-tauri/src/source_headers.rs"]
pub mod source_headers;
#[path = "../../../src-tauri/src/historical_sources.rs"]
pub mod historical_sources;
#[path = "../../../src-tauri/src/earth_history/mod.rs"]
pub mod earth_history;
#[path = "../../../src-tauri/src/geovis.rs"]
pub mod geovis;
#[path = "../../../src-tauri/src/tile_cache/mod.rs"]
pub mod tile_cache;
#[path = "../../../src-tauri/src/cache_access.rs"]
pub mod cache_access;
#[path = "../../../src-tauri/src/pause_control.rs"]
pub mod pause_control;
#[path = "../../../src-tauri/src/fs_util.rs"]
pub mod fs_util;
#[path = "../../../src-tauri/src/geotiff_sidecar.rs"]
pub mod geotiff_sidecar;

pub mod pipeline;
mod imagery_job;

// The shared TIFF writer consults desktop settings in its convenience wrapper.
// CLI calls its explicit-budget entry point; this fallback keeps the shared
// module headless without reading the desktop application's configuration.
mod settings {
    pub struct SettingsManager;
    #[derive(serde::Deserialize)]
    #[serde(default)]
    pub struct AppSettings { pub export_buffer_mb: u32, pub tianditu_token: Option<String>, pub tianditu_backup_tokens: Vec<String> }
    impl Default for AppSettings { fn default()->Self { Self { export_buffer_mb:64,tianditu_token:None,tianditu_backup_tokens:Vec::new() } } }
    impl SettingsManager {
        pub fn new() -> Result<Self, String> { Ok(Self) }
        pub fn get(&self) -> Result<AppSettings, String> { Err("Desktop settings are not read by the headless core".into()) }
    }
}
pub mod vector;
pub mod clip;
