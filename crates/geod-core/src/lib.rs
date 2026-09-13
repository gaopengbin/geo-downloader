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
#[path = "../../../src-tauri/src/downloader.rs"]
pub mod downloader;
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
pub mod vector;
pub mod clip;
