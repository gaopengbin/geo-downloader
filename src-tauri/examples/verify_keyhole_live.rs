use app_lib::{
    earth_history::{keyhole, transport},
    settings::SettingsManager,
    tile,
};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), String> {
    let out = PathBuf::from(std::env::args().nth(1).ok_or("output directory required")?);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let settings = SettingsManager::new()?.get()?;
    let proxy = settings.proxy_enabled.then_some(settings.proxy_url);
    let client = transport::Transport::new(proxy.as_deref(), 64, 64 * 1024 * 1024)?.client();
    let mut records = Vec::new();
    for (lon, lat, label, date) in [
        (-122.401, 37.79068788, "sf-2024", "2024-04-30"),
        (-122.401, 37.79068788, "sf-2026", "2026-07-14"),
        (116.397, 39.908, "beijing-2024", "2024-12-07"),
        (104.1954, 35.8617, "china-overview", "1996-12-31"),
    ] {
        let catalog = keyhole::dates(
            lon,
            lat,
            if label == "china-overview" { 4 } else { 14 },
            client.clone(),
        )
        .await?;
        let root = catalog["rootId"].as_str().unwrap();
        let context = keyhole::session(root, date)?;
        std::fs::write(
            out.join(format!("{label}-catalog.json")),
            serde_json::to_vec_pretty(&catalog).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        let levels = if label == "sf-2026" {
            vec![15, 16]
        } else if label == "china-overview" {
            vec![4]
        } else {
            vec![15]
        };
        for z in levels {
            let scale = 2f64.powi(z as i32);
            let x = ((lon + 180.) / 360. * scale).floor() as u32;
            let y = ((1. - lat.to_radians().tan().asinh() / std::f64::consts::PI) / 2. * scale)
                .floor() as u32;
            for dx in if label == "sf-2026" {
                vec![0, 1]
            } else {
                vec![0]
            } {
                let bytes =
                    keyhole::read_tile(&context.source().id, z, x + dx, y, client.clone()).await?;
                let image = image::load_from_memory(&bytes)
                    .map_err(|e| e.to_string())?
                    .to_rgba8();
                let opaque = image.pixels().filter(|p| p[3] > 0).count();
                if opaque == 0 {
                    return Err(format!("{label}: empty tile"));
                }
                std::fs::write(out.join(format!("{label}-{z}-{}-{y}.png", x + dx)), &bytes)
                    .map_err(|e| e.to_string())?;
                let cached =
                    keyhole::read_tile(&context.source().id, z, x + dx, y, client.clone()).await?;
                if bytes != cached {
                    return Err("cache identity mismatch".into());
                }
                records.push(serde_json::json!({"label":label,"date":date,"z":z,"x":x+dx,"y":y,"opaque":opaque,"sha256":format!("{:x}",Sha256::digest(&bytes)),"source":context.source()}));
            }
        }
        if label == "sf-2026" {
            let bounds = [-122.402, 37.790, -122.400, 37.792];
            let plan = keyhole::plan(&context.source().id, bounds, 17, client.clone()).await?;
            keyhole::validate_export(&plan.source().id, bounds, &[17])?;
            let coords = tile::get_tiles_in_bounds(
                &tile::Bounds {
                    west: bounds[0],
                    south: bounds[1],
                    east: bounds[2],
                    north: bounds[3],
                },
                17,
            );
            let files = app_lib::downloader::TileDownloader::new(plan.source(), proxy.as_deref())?
                .download_tiles(
                    coords.clone(),
                    2,
                    &out.join("export-tiles"),
                    None,
                    None,
                    |_| {},
                )
                .await?;
            let xmin = coords.iter().map(|c| c.x).min().unwrap();
            let xmax = coords.iter().map(|c| c.x).max().unwrap();
            let ymin = coords.iter().map(|c| c.y).min().unwrap();
            let ymax = coords.iter().map(|c| c.y).max().unwrap();
            let b = tile::get_merged_bounds(xmin, ymin, xmax, ymax, 17);
            let sources = files;
            app_lib::streaming_tiff::merge_and_export_streaming(
                &sources,
                xmin,
                ymin,
                xmax,
                ymax,
                &b,
                &out.join("keyhole-2026-07-14.tif"),
                "lzw",
                Some(&[]),
            )?;
            app_lib::earth_history::write_manifest_for_grid(
                &out.join("keyhole-2026-07-14.tif"),
                &plan.source().id,
                &b,
                (xmax - xmin + 1) * 256,
                (ymax - ymin + 1) * 256,
                17,
            )?;
            records.push(serde_json::json!({"exportSource":plan.source(),"tileCount":coords.len(),"status":keyhole::status(&context.source().id)}));
        }
    }
    std::fs::write(
        out.join("verified.json"),
        serde_json::to_vec_pretty(&records).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::json!({"verified":records.len(),"output":out})
    );
    Ok(())
}
