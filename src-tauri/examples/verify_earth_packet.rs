use app_lib::{
    earth_history::{decoder, raster, transport},
    exporter,
    tile::TileBounds,
};
use std::path::PathBuf;

fn main() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("provide packet path and a new output directory".into());
    }
    let output = PathBuf::from(&args[2]);
    if output.exists() {
        return Err("output already exists".into());
    }
    let raw = std::fs::read(&args[1]).map_err(|e| e.to_string())?;
    let body = transport::decode_body(&raw)?;
    let node = decoder::decode(&body)?;
    let b = node.bounds;
    let project = |lon: f64, lat: f64| {
        [
            6378137. * lon.to_radians(),
            6378137.
                * (std::f64::consts::PI / 4. + lat.to_radians() / 2.)
                    .tan()
                    .ln(),
        ]
    };
    let low = project(b[0], b[1]);
    let high = project(b[2], b[3]);
    let image = raster::render(
        std::slice::from_ref(&node),
        [low[0], low[1], high[0], high[1]],
        256,
        256,
    )?;
    let valid = image.pixels().filter(|p| p[3] > 0).count();
    if valid < 60_000 {
        return Err(format!("insufficient valid coverage: {valid}/65536"));
    }
    std::fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    image
        .save(output.join("preview.png"))
        .map_err(|e| e.to_string())?;
    let bounds = TileBounds {
        west: b[0],
        south: b[1],
        east: b[2],
        north: b[3],
    };
    let tiff = exporter::export_rgba_tiff_bytes(&image, Some(&bounds), "lzw")?;
    std::fs::write(output.join("imagery.tif"), tiff).map_err(|e| e.to_string())?;
    let report = serde_json::json!({"wireSha256":transport::sha(&raw),"decodedSha256":transport::sha(&body),"bounds":b,
        "meshes":node.meshes.len(),"vertices":node.meshes.iter().map(|m|m.positions.len()).sum::<usize>(),"validPixels":valid,"crs":"EPSG:3857",
        "coordinateBasis":"Recovered original Earth spherical angular coordinates, transformed to Web Mercator","copyrightIds":node.copyrights,"earthEngineLoaded":false});
    std::fs::write(
        output.join("verification.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    println!("{report}");
    Ok(())
}
