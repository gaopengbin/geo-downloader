//! Headless imagery exports built from the same downloader and tile packers as the desktop app.
use crate::{
    clip,
    config::TileSource,
    downloader::TileDownloader,
    exporter, geotiff_sidecar, merger,
    pipeline::{self, ImageryRequest, Manifest, OverlayRequest, Request},
    pyramid, streaming_raster, streaming_tiff, tile, tile_cache, tile_pack,
};
use image::{DynamicImage, ImageFormat};
use std::{collections::HashMap, fs, io::Cursor, path::Path};

fn source(
    url: &str,
    name: &str,
    attribution: &str,
    subdomains: &[String],
    max_zoom: u8,
) -> TileSource {
    TileSource {
        id: "geod-cli-xyz".into(),
        name: name.into(),
        url: url.into(),
        subdomains: subdomains.to_vec(),
        max_zoom,
        attribution: attribution.into(),
    }
}

fn valid_image(bytes: &[u8], tile_size: u32) -> bool {
    image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()
        .and_then(|reader| reader.into_dimensions().ok())
        == Some((tile_size, tile_size))
        && image::load_from_memory(bytes).is_ok()
}

fn png_tile(image: image::RgbaImage) -> Result<merger::TileSource, String> {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(merger::TileSource::from_bytes(bytes.into_inner()))
}

async fn add_overlay(
    overlay: &OverlayRequest,
    zoom: u8,
    concurrency: usize,
    tile_size: u32,
    stage: &Path,
    work_dir: Option<&Path>,
    tiles: &mut HashMap<(u32, u32), merger::TileSource>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if zoom > overlay.max_zoom.unwrap_or(22) {
        warnings.push(format!(
            "Overlay '{}' skipped at z{}: above maxZoom",
            overlay.source, zoom
        ));
        return Ok(());
    }
    let downloader = TileDownloader::new(
        source(
            &overlay.url,
            &overlay.source,
            &overlay.attribution,
            &overlay.subdomains,
            overlay.max_zoom.unwrap_or(22),
        ),
        None,
    )?;
    let coords: Vec<_> = tiles
        .keys()
        .map(|&(x, y)| tile::TileCoord { x, y, z: zoom })
        .collect();
    let overlay_dir = tempfile::Builder::new()
        .prefix(".overlay-")
        .tempdir_in(stage)
        .map_err(|e| e.to_string())?;
    if let Some(path) = work_dir {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
    }
    let download_dir = work_dir.unwrap_or_else(|| overlay_dir.path());
    let downloaded = downloader
        .download_tiles(coords, concurrency, download_dir, None, None, |_| {})
        .await?;
    if downloaded.len() < tiles.len() {
        warnings.push(format!(
            "Overlay '{}' missing {}/{} tiles at z{}",
            overlay.source,
            tiles.len() - downloaded.len(),
            tiles.len(),
            zoom
        ));
    }
    for (coord, base) in tiles.iter_mut() {
        let Some(overlay_tile) = downloaded.get(coord) else {
            continue;
        };
        let overlay_bytes = overlay_tile.bytes().map_err(|e| e.to_string())?;
        let Ok(top) = image::load_from_memory(overlay_bytes.as_ref()) else {
            continue;
        };
        if top.width() != top.height() || ![256, 512].contains(&top.width()) {
            continue;
        }
        let base_bytes = base.bytes().map_err(|e| e.to_string())?;
        let mut bottom = image::load_from_memory(base_bytes.as_ref())
            .map_err(|e| e.to_string())?
            .to_rgba8();
        if bottom.dimensions() != (tile_size, tile_size) { continue; }
        let top = if top.width() == tile_size { top.to_rgba8() } else {
            image::imageops::resize(&top.to_rgba8(), tile_size, tile_size, image::imageops::FilterType::Triangle)
        };
        image::imageops::overlay(&mut bottom, &top, 0, 0);
        *base = png_tile(bottom)?;
    }
    Ok(())
}

fn normalize_png(tiles: &mut HashMap<(u32, u32), merger::TileSource>) -> Result<(), String> {
    for item in tiles.values_mut() {
        let bytes = item.bytes().map_err(|e| e.to_string())?;
        let image = image::load_from_memory(bytes.as_ref()).map_err(|e| e.to_string())?;
        *item = png_tile(image.to_rgba8())?;
    }
    Ok(())
}

fn add_asset(
    m: &mut Manifest,
    stage: &Path,
    id: &str,
    path: &str,
    kind: &str,
    role: &str,
    mime: &str,
    bounds: [f64; 4],
    dimensions: Option<(u32, u32)>,
) -> Result<(), String> {
    let mut item = pipeline::asset(stage, id, path, kind, role, mime, "EPSG:3857", bounds)?;
    if let Some((width, height)) = dimensions {
        item.width = Some(width);
        item.height = Some(height);
    }
    m.assets.push(item);
    Ok(())
}

fn write_preview_from_tiles(
    stage: &Path,
    m: &mut Manifest,
    tiles: &HashMap<(u32, u32), merger::TileSource>,
    x0: u32,
    y0: u32,
    x1: u32,
    y1: u32,
    tile_size: u32,
    bounds: &tile::TileBounds,
    clip_data: Option<(&serde_json::Value, &str)>,
) -> Result<(), String> {
    let full_width = (x1 - x0 + 1) * tile_size;
    let full_height = (y1 - y0 + 1) * tile_size;
    let scale = (2048.0 / f64::from(full_width.max(full_height))).min(1.0);
    let width = (f64::from(full_width) * scale).round().max(1.0) as u32;
    let height = (f64::from(full_height) * scale).round().max(1.0) as u32;
    let mut preview = image::RgbImage::from_pixel(width, height, image::Rgb([255, 255, 255]));
    for (&(x, y), source) in tiles {
        let bytes = source.bytes().map_err(|e| e.to_string())?;
        let tile = image::load_from_memory(bytes.as_ref())
            .map_err(|e| e.to_string())?
            .to_rgb8();
        let left = (u64::from(x - x0) * u64::from(tile_size) * u64::from(width) / u64::from(full_width)) as u32;
        let right = (u64::from(x - x0 + 1) * u64::from(tile_size) * u64::from(width) / u64::from(full_width)) as u32;
        let top = (u64::from(y - y0) * u64::from(tile_size) * u64::from(height) / u64::from(full_height)) as u32;
        let bottom =
            (u64::from(y - y0 + 1) * u64::from(tile_size) * u64::from(height) / u64::from(full_height)) as u32;
        if right > left && bottom > top {
            let tile = image::imageops::resize(
                &tile,
                right - left,
                bottom - top,
                image::imageops::FilterType::Triangle,
            );
            image::imageops::replace(&mut preview, &tile, i64::from(left), i64::from(top));
        }
    }
    let path = stage.join("imagery-preview.png");
    if let Some((vectors, layer)) = clip_data {
        let clipped = clip::clip_raster(preview, vectors, layer, bounds)?;
        exporter::export_rgba_image_to_file(
            clipped,
            exporter::ExportFormat::Png,
            &path,
            Some(bounds),
            "lzw",
        )?;
    } else {
        exporter::export_image_to_file(
            preview,
            exporter::ExportFormat::Png,
            &path,
            Some(bounds),
            "lzw",
        )?;
    }
    add_asset(
        m,
        stage,
        "imagery-preview",
        "imagery-preview.png",
        "raster",
        "preview",
        "image/png",
        pipeline::footprint(bounds),
        Some((width, height)),
    )
}

pub(crate) async fn execute(
    request: &Request,
    i: &ImageryRequest,
    stage: &Path,
    m: &mut Manifest,
    tile_work_dir: Option<&Path>,
) -> Result<(), String> {
    let zooms = pipeline::selected_zooms(i)?;
    let last_zoom = *zooms.last().expect("validated zooms");
    let b = pipeline::tile_bounds(request.bounds);
    let format = i.format.as_str();
    let pack = matches!(format, "mbtiles" | "gpkg");
    let raw = format == "tiles";
    let package_name = if format == "mbtiles" {
        "imagery.mbtiles"
    } else {
        "imagery.gpkg"
    };
    let vector = if i.clip_to_layer.is_some() {
        Some(
            serde_json::from_slice::<serde_json::Value>(
                &fs::read(stage.join("data.geojson")).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?,
        )
    } else if i.crop_to_shape {
        let features: Vec<_> = i
            .polygon
            .as_ref()
            .expect("validated polygon")
            .iter()
            .map(|ring| {
                let mut coordinates: Vec<[f64; 2]> =
                    ring.iter().map(|point| [point.lng, point.lat]).collect();
                if coordinates.first() != coordinates.last() {
                    coordinates.push(coordinates[0]);
                }
                serde_json::json!({"type":"Feature","properties":{"layer":"selection"},
                "geometry":{"type":"Polygon","coordinates":[coordinates]}})
            })
            .collect();
        Some(serde_json::json!({"type":"FeatureCollection","features":features}))
    } else {
        None
    };
    tile_cache::set_enabled(false);
    let downloader = TileDownloader::new(
        source(&i.url, &i.source, &i.attribution, &i.subdomains, 22),
        None,
    )?;

    for &zoom in &zooms {
        let temporary = tempfile::Builder::new()
            .prefix(".geod-tiles-")
            .tempdir_in(stage)
            .map_err(|e| e.to_string())?;
        let work_path = tile_work_dir.map(|p| p.join(format!("z{zoom}")));
        if let Some(path) = &work_path {
            fs::create_dir_all(path).map_err(|e| e.to_string())?;
        }
        let download_dir = work_path.as_deref().unwrap_or_else(|| temporary.path());
        let coords = tile::get_tiles_in_bounds(&b, zoom);
        let expected = coords.len() as u32;
        let mut last_report = 0;
        let files = downloader
            .download_tiles(coords, i.concurrency, download_dir, None, None, |p| {
                if p.completed != last_report {
                    eprintln!(
                        "{}",
                        serde_json::json!({"phase":"download","zoom":zoom,
                    "completed":p.completed,"total":p.total,"failed":p.failed,"noData":p.no_data})
                    );
                    last_report = p.completed;
                }
            })
            .await?;
        let mut valid = HashMap::new();
        for (key, item) in files {
            let bytes = item.bytes().map_err(|e| e.to_string())?;
            if valid_image(bytes.as_ref(), i.tile_size) {
                drop(bytes);
                valid.insert(key, item);
            } else {
                m.quality.warnings.push(format!(
                    "Invalid or non-{}px tile omitted at z{zoom}: {}/{}",
                    i.tile_size, key.0, key.1
                ));
            }
        }
        let missing = expected.saturating_sub(valid.len() as u32);
        if valid.is_empty() {
            return Err(format!(
                "NO_DATA: no valid imagery tiles received at z{zoom}"
            ));
        }
        if missing > 0 && !i.allow_missing {
            return Err(format!("MISSING_TILES: {missing}/{expected} unavailable at z{zoom}; set imagery.allowMissing to accept gaps"));
        }
        if missing > 0 {
            m.quality.status = "partial".into();
            m.quality.missing_tiles += missing;
            m.quality.warnings.push(format!(
                "z{zoom}: {missing} missing tiles are white in the mosaic"
            ));
        }
        for (index, overlay) in i.overlays.iter().enumerate() {
            eprintln!(
                "{}",
                serde_json::json!({"phase":"overlay","zoom":zoom,"source":overlay.source})
            );
            let overlay_work = tile_work_dir.map(|p| p.join(format!("overlay-{index}/z{zoom}")));
            add_overlay(
                overlay,
                zoom,
                i.concurrency,
                i.tile_size,
                stage,
                overlay_work.as_deref(),
                &mut valid,
                &mut m.quality.warnings,
            )
            .await?;
        }
        let (x0, y0, x1, y1, _, _) = tile::get_tile_matrix_size(&b, zoom);
        let bounds = tile::get_merged_bounds(x0, y0, x1, y1, zoom);
        let single = zooms.len() == 1;

        if pack {
            // A raster tile package advertises one format. Normalize source tiles to PNG.
            normalize_png(&mut valid)?;
            let path = stage.join(package_name);
            let metadata = tile_pack::PackMetadata {
                name: request.name.clone(),
                format: "png".into(),
                bounds: tile::TileBounds {
                    west: b.west,
                    south: b.south,
                    east: b.east,
                    north: b.north,
                },
                min_zoom: zooms[0],
                max_zoom: last_zoom,
                attribution: Some(i.attribution.clone()),
                description: None,
            };
            let initial = if path.exists() { None } else { Some(&metadata) };
            eprintln!(
                "{}",
                serde_json::json!({"phase":"export","zoom":zoom,"format":format})
            );
            if format == "mbtiles" {
                tile_pack::append_zoom_to_mbtiles(&path, zoom, &valid, initial)?;
            } else {
                tile_pack::append_zoom_to_gpkg(&path, zoom, &valid, initial)?;
            }
        } else if raw {
            let detected = tile_pack::detect_tile_format(&valid);
            let uniform = valid.values().all(|item| {
                item.bytes()
                    .ok()
                    .and_then(|bytes| image::guess_format(bytes.as_ref()).ok())
                    .map(|kind| match kind {
                        ImageFormat::Png => "png",
                        ImageFormat::Jpeg => "jpg",
                        ImageFormat::WebP => "webp",
                        _ => "other",
                    })
                    == Some(detected.as_str())
            });
            let ext = if uniform && matches!(detected.as_str(), "png" | "jpg" | "webp") {
                detected
            } else {
                normalize_png(&mut valid)?;
                "png".to_string()
            };
            let root = stage.join("tiles");
            tile_pack::write_raw_tiles_folder(&root, zoom, &valid, &ext)?;
            for &(x, y) in valid.keys() {
                let path = format!("tiles/{zoom}/{x}/{y}.{ext}");
                let tile_bounds = tile::get_merged_bounds(x, y, x, y, zoom);
                add_asset(
                    m,
                    stage,
                    &format!("tile-{zoom}-{x}-{y}"),
                    &path,
                    "tile",
                    "analysis",
                    match ext.as_str() {
                        "jpg" => "image/jpeg",
                        "webp" => "image/webp",
                        _ => "image/png",
                    },
                    pipeline::footprint(&tile_bounds),
                    Some((i.tile_size, i.tile_size)),
                )?;
            }
        }

        if pack || raw {
            if zoom == last_zoom {
                write_preview_from_tiles(stage, m, &valid, x0, y0, x1, y1, i.tile_size, &bounds, None)?;
            }
            continue;
        }

        eprintln!(
            "{}",
            serde_json::json!({"phase":"export","zoom":zoom,"format":format})
        );
        let width = (x1 - x0 + 1) * i.tile_size;
        let height = (y1 - y0 + 1) * i.tile_size;
        let (export_format, ext, mime) = match format {
            "png" => (exporter::ExportFormat::Png, "png", "image/png"),
            "jpeg" => (exporter::ExportFormat::Jpeg, "jpg", "image/jpeg"),
            _ => (exporter::ExportFormat::GeoTiff, "tif", "image/tiff"),
        };
        let file = if single {
            format!("imagery.{ext}")
        } else {
            format!("imagery-z{zoom}.{ext}")
        };
        let clip_layer = if i.crop_to_shape {
            Some("selection")
        } else {
            i.clip_to_layer.as_deref()
        };
        if zoom == last_zoom {
            write_preview_from_tiles(
                stage,
                m,
                &valid,
                x0,
                y0,
                x1,
                y1,
                i.tile_size,
                &bounds,
                clip_layer.and_then(|layer| vector.as_ref().map(|data| (data, layer))),
            )?;
        }
        if i.tile_size == 256 && clip_layer.is_none() && format == "geotiff" {
            streaming_tiff::merge_and_export_streaming_with_budget(
                &valid,
                x0,
                y0,
                x1,
                y1,
                &bounds,
                &stage.join(&file),
                &i.compression,
                None,
                64 * 1024 * 1024,
            )?;
        } else if i.tile_size == 256 && clip_layer.is_none() && format == "png" {
            streaming_raster::merge_and_export_streaming_png(
                &valid,
                x0,
                y0,
                x1,
                y1,
                &bounds,
                &stage.join(&file),
                None,
            )?;
        } else if let (Some(layer), Some(vectors)) = (clip_layer, &vector) {
            eprintln!("{}", serde_json::json!({"phase":"clip","zoom":zoom}));
            let image = merger::merge_tiles_sized(&valid, x0, y0, x1, y1, i.tile_size);
            let clipped = clip::clip_raster(image, vectors, layer, &bounds)?;
            exporter::export_rgba_image_to_file(
                clipped,
                export_format,
                &stage.join(&file),
                Some(&bounds),
                &i.compression,
            )?;
        } else {
            let image = merger::merge_tiles_sized(&valid, x0, y0, x1, y1, i.tile_size);
            exporter::export_image_to_file(
                image,
                export_format,
                &stage.join(&file),
                Some(&bounds),
                &i.compression,
            )?;
        }
        if i.build_pyramid {
            eprintln!("{}", serde_json::json!({"phase":"pyramid","zoom":zoom}));
            pyramid::build_pyramid(
                stage.join(&file),
                pyramid::PyramidOptions {
                    compression: i.compression.clone(),
                    ..Default::default()
                },
            )?;
        }
        add_asset(
            m,
            stage,
            &if single {
                "imagery".into()
            } else {
                format!("imagery-z{zoom}")
            },
            &file,
            "raster",
            "analysis",
            mime,
            pipeline::footprint(&bounds),
            Some((width, height)),
        )?;
        if i.generate_sidecars {
            geotiff_sidecar::write_geotiff_sidecars(
                &stage.join(&file),
                &bounds,
                width,
                height,
                geotiff_sidecar::SidecarCrs::WebMercator,
            )?;
            let stem = file.strip_suffix(".tif").expect("validated geotiff");
            for ext in ["tfw", "prj"] {
                let path = format!("{stem}.{ext}");
                add_asset(
                    m,
                    stage,
                    &format!("{stem}-{ext}"),
                    &path,
                    "metadata",
                    "sidecar",
                    "text/plain",
                    pipeline::footprint(&bounds),
                    None,
                )?;
            }
        }
    }
    if pack {
        add_asset(
            m,
            stage,
            "imagery",
            package_name,
            "tile-package",
            "analysis",
            if format == "mbtiles" {
                "application/vnd.mbtiles"
            } else {
                "application/geopackage+sqlite3"
            },
            request.bounds,
            None,
        )?;
    }
    if let Some(layer) = &i.clip_to_layer {
        m.quality.warnings.push(format!("Raster clipped to polygon union in layer '{layer}'; outside pixels are transparent. Vector geometries are unchanged."));
    } else if i.crop_to_shape {
        m.quality
            .warnings
            .push("Raster clipped to the supplied polygon; outside pixels are transparent.".into());
    }
    m.provenance.push(pipeline::Provenance {
        source: i.source.clone(),
        attribution: i.attribution.clone(),
        retrieved_at: m.created_at.clone(),
    });
    for overlay in &i.overlays {
        m.provenance.push(pipeline::Provenance {
            source: overlay.source.clone(),
            attribution: overlay.attribution.clone(),
            retrieved_at: m.created_at.clone(),
        });
    }
    Ok(())
}
