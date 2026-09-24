//! GeoD's headless engine. These modules intentionally share their source with
//! the desktop app while the public job API is developed, keeping download,
//! tile math and export fixes in one place without importing Tauri.

#[path = "../../../src-tauri/src/config.rs"]
pub mod config;
#[path = "../../../src-tauri/src/tile.rs"]
pub mod tile;
#[path = "../../../src-tauri/src/merger.rs"]
pub mod merger;
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
#[path = "../../../src-tauri/src/tile_policy.rs"]
pub mod tile_policy;
#[path = "../../../src-tauri/src/tile_payload.rs"]
pub mod tile_payload;
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
    pub struct Settings { pub export_buffer_mb: u32 }
    impl SettingsManager {
        pub fn new() -> Result<Self, String> { Ok(Self) }
        pub fn get(&self) -> Result<Settings, String> { Ok(Settings { export_buffer_mb: 64 }) }
    }
}
pub mod vector;
pub mod clip;
