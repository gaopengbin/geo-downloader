use app_lib::{
    downloader::TileDownloader,
    earth_history::{catalog, planner, raster, transport},
    exporter, merger, streaming_raster, streaming_tiff,
    tile::{self, Bounds, TileBounds},
};
use std::path::PathBuf;
#[tokio::main]
async fn main() -> Result<(), String> {
    let out = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .ok_or("provide a new output directory")?;
    if out.exists() {
        return Err("output exists".into());
    }
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let result = catalog::discover([-122.402, 37.790, -122.400, 37.792], 17, None).await?;
    std::fs::write(
        out.join("catalog.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    println!(
        "{}",
        serde_json::json!({"catalogId":result.id,"nodes":result.nodes.len(),"dates":result.dates.len(),
        "complete":result.catalog_complete,"requests":result.metadata_requests,"latest":result.dates.first(),"cache":transport::directory()?})
    );
    for date in ["2026-03-06", "2026-07-14"] {
        let plan = planner::prepare(&result.id, date)?;
        let client = reqwest::Client::builder()
            .gzip(false)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let nodes = planner::nodes(&plan, client).await?;
        let b = plan.bounds;
        let p = |lon: f64, lat: f64| {
            [
                6378137. * lon.to_radians(),
                6378137.
                    * (std::f64::consts::PI / 4. + lat.to_radians() / 2.)
                        .tan()
                        .ln(),
            ]
        };
        let lo = p(b[0], b[1]);
        let hi = p(b[2], b[3]);
        let image = raster::render(&nodes, [lo[0], lo[1], hi[0], hi[1]], 256, 256)?;
        let valid = image.pixels().filter(|pixel| pixel[3] > 0).count();
        if valid < 60_000 {
            return Err(format!("{date}: incomplete sample coverage {valid}/65536"));
        }
        image
            .save(out.join(format!("{date}.png")))
            .map_err(|e| e.to_string())?;
        let bounds = TileBounds {
            west: b[0],
            south: b[1],
            east: b[2],
            north: b[3],
        };
        std::fs::write(
            out.join(format!("{date}.tif")),
            exporter::export_rgba_tiff_bytes(&image, Some(&bounds), "lzw")?,
        )
        .map_err(|e| e.to_string())?;
        planner::write_manifest(&out.join(format!("{date}.tif")), &plan.source().id)?;
        let bounds = Bounds {
            west: b[0],
            south: b[1],
            east: b[2],
            north: b[3],
        };
        let coordinates = tile::get_tiles_in_bounds(&bounds, 17);
        let xmin = coordinates.iter().map(|t| t.x).min().unwrap();
        let xmax = coordinates.iter().map(|t| t.x).max().unwrap();
        let ymin = coordinates.iter().map(|t| t.y).min().unwrap();
        let ymax = coordinates.iter().map(|t| t.y).max().unwrap();
        let files = TileDownloader::new(plan.source(), None)?
            .download_tiles(
                coordinates,
                2,
                &out.join(format!("tiles-{date}")),
                None,
                None,
                |_| {},
            )
            .await?;
        if files.len() != plan.tile_count {
            return Err(format!("{date}: raster block count mismatch"));
        }
        let grid = tile::get_merged_bounds(xmin, ymin, xmax, ymax, 17);
        let polygons = vec![vec![
            merger::PolygonPoint {
                lat: b[1],
                lng: b[0],
            },
            merger::PolygonPoint {
                lat: b[3],
                lng: b[0],
            },
            merger::PolygonPoint {
                lat: b[3],
                lng: b[2],
            },
            merger::PolygonPoint {
                lat: b[1],
                lng: b[2],
            },
        ]];
        let path = out.join(format!("{date}-geod-grid.tif"));
        streaming_tiff::merge_and_export_streaming(
            &files,
            xmin,
            ymin,
            xmax,
            ymax,
            &grid,
            &path,
            "lzw",
            Some(&polygons),
        )?;
        streaming_raster::merge_and_export_streaming_png(
            &files,
            xmin,
            ymin,
            xmax,
            ymax,
            &grid,
            &out.join(format!("{date}-geod-grid.png")),
            Some(&polygons),
        )?;
        planner::write_manifest(&path, &plan.source().id)?;
        println!(
            "verified {date}: {} nodes, {} output tiles, {valid} valid pixels, plan {}",
            nodes.len(),
            plan.tile_count,
            plan.id
        );
    }
    Ok(())
}
