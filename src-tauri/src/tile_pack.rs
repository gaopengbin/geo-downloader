//! 把瓦片打包成 MBTiles / GPKG 文件。
//!
//! 设计参考 `docs/browse-as-cache-design.md`。
//!
//! - MBTiles 1.3：tiles(zoom_level, tile_column, tile_row, tile_data)，行号为 TMS（左下原点）
//! - GeoPackage 1.3 raster：tiles(id, zoom_level, tile_column, tile_row, tile_data)，行号为 XYZ（左上原点）

use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

use crate::merger::TileSource;
use crate::tile::TileBounds;
use crate::tile_cache::xyz_to_tms_row;

/// 单个瓦片输入：XYZ 坐标 + 字节
pub struct PackTile {
    pub z: u8,
    pub x: u32,
    pub y: u32,
    pub bytes: Vec<u8>,
}

/// 公共元信息
pub struct PackMetadata {
    pub name: String,
    pub format: String, // "png" | "jpg" | "webp"
    pub bounds: TileBounds,
    pub min_zoom: u8,
    pub max_zoom: u8,
    pub attribution: Option<String>,
    pub description: Option<String>,
}

fn read_tile_bytes(source: &TileSource) -> Result<Vec<u8>, String> {
    source
        .bytes()
        .map(|cow| cow.into_owned())
        .map_err(|e| {
            let where_str = source
                .as_path()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "<memory>".to_string());
            format!("读取瓦片失败 {}: {}", where_str, e)
        })
}

/// 把字节流按 gzip 压缩。已经是 gzip（魔数 1F 8B）则原样返回。
/// 用于 MBTiles 1.3 矢量瓦片规范：tile_data 必须是 gzip 压缩的 protobuf。
fn gzip_if_needed(bytes: Vec<u8>) -> Result<Vec<u8>, String> {
    if bytes.len() >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B {
        return Ok(bytes);
    }
    use flate2::write::GzEncoder;
    use flate2::Compression;
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len()), Compression::default());
    enc.write_all(&bytes).map_err(|e| format!("gzip 压缩失败: {}", e))?;
    enc.finish().map_err(|e| format!("gzip 压缩失败: {}", e))
}

/// 从 gzip 或原始 MVT protobuf 中提取所有 layer 的 name 字段。
/// 用于生成 MBTiles 矢量瓦片规范要求的 metadata.json (vector_layers)。
/// 失败时返回空 Vec，调用方可继续。
fn extract_mvt_layer_names(bytes: &[u8]) -> Vec<String> {
    // 解压 gzip 头
    let plain: Vec<u8> = if bytes.len() >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B {
        use flate2::read::GzDecoder;
        use std::io::Read;
        let mut d = GzDecoder::new(bytes);
        let mut v = Vec::new();
        if d.read_to_end(&mut v).is_err() {
            return Vec::new();
        }
        v
    } else {
        bytes.to_vec()
    };
    // 极简 protobuf 解析：遍历 Tile 顶层字段，找 tag=3 (layers, length-delimited)
    let mut names = Vec::new();
    let mut i = 0usize;
    while i < plain.len() {
        let (tag, n) = match read_varint(&plain[i..]) {
            Some(v) => v,
            None => return names,
        };
        i += n;
        let field_no = (tag >> 3) as u32;
        let wire = (tag & 0x07) as u32;
        match wire {
            0 => {
                // varint
                let (_, n2) = match read_varint(&plain[i..]) {
                    Some(v) => v,
                    None => return names,
                };
                i += n2;
            }
            1 => {
                if i + 8 > plain.len() {
                    return names;
                }
                i += 8;
            }
            5 => {
                if i + 4 > plain.len() {
                    return names;
                }
                i += 4;
            }
            2 => {
                let (len, n2) = match read_varint(&plain[i..]) {
                    Some(v) => v,
                    None => return names,
                };
                i += n2;
                let len = len as usize;
                if i + len > plain.len() {
                    return names;
                }
                if field_no == 3 {
                    // 进入 Layer 消息，找 name (tag=1, wire=2)
                    let layer = &plain[i..i + len];
                    let mut j = 0usize;
                    while j < layer.len() {
                        let (ltag, ln) = match read_varint(&layer[j..]) {
                            Some(v) => v,
                            None => break,
                        };
                        j += ln;
                        let lfn = (ltag >> 3) as u32;
                        let lw = (ltag & 0x07) as u32;
                        match lw {
                            0 => {
                                let (_, n2) = match read_varint(&layer[j..]) {
                                    Some(v) => v,
                                    None => break,
                                };
                                j += n2;
                            }
                            1 => j += 8,
                            5 => j += 4,
                            2 => {
                                let (slen, sn) = match read_varint(&layer[j..]) {
                                    Some(v) => v,
                                    None => break,
                                };
                                j += sn;
                                let slen = slen as usize;
                                if j + slen > layer.len() {
                                    break;
                                }
                                if lfn == 1 {
                                    if let Ok(s) = std::str::from_utf8(&layer[j..j + slen]) {
                                        names.push(s.to_string());
                                    }
                                }
                                j += slen;
                            }
                            _ => break,
                        }
                    }
                }
                i += len;
            }
            _ => return names,
        }
    }
    names
}

fn read_varint(buf: &[u8]) -> Option<(u64, usize)> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    for (i, &b) in buf.iter().enumerate() {
        result |= ((b & 0x7F) as u64) << shift;
        if b & 0x80 == 0 {
            return Some((result, i + 1));
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

fn detect_format(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        "jpg"
    } else if bytes.len() >= 4 && bytes[0] == 0x89 && bytes[1] == 0x50 {
        "png"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.len() >= 4
        && ((bytes[0] == 0x49 && bytes[1] == 0x49 && bytes[2] == 0x2A && bytes[3] == 0x00)
            || (bytes[0] == 0x4D && bytes[1] == 0x4D && bytes[2] == 0x00 && bytes[3] == 0x2A)
            // BigTIFF：II/MM + version 43
            || (bytes[0] == 0x49 && bytes[1] == 0x49 && bytes[2] == 0x2B && bytes[3] == 0x00)
            || (bytes[0] == 0x4D && bytes[1] == 0x4D && bytes[2] == 0x00 && bytes[3] == 0x2B))
    {
        "tif"
    } else if bytes.len() >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B {
        // gzip 头部：MVT 瓦片返回时通常带 Content-Encoding: gzip，
        // 但 reqwest 在启用 gzip feature 后会自动解压；
        // 如果未解压则这里会看到 1F 8B。视为 pbf。
        "pbf"
    } else {
        // 默认 fallback：MVT 原始 protobuf 没有固定 magic，
        // 调用方应该使用 detect_tile_format_with_hint 传入外部提示。
        "png"
    }
}

// ===== MBTiles =====

fn open_mbtiles(path: &Path, init_meta: Option<&PackMetadata>) -> Result<Connection, String> {
    let exists = path.exists();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode=DELETE;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
         CREATE TABLE IF NOT EXISTS tiles (
             zoom_level INTEGER NOT NULL,
             tile_column INTEGER NOT NULL,
             tile_row INTEGER NOT NULL,
             tile_data BLOB,
             PRIMARY KEY (zoom_level, tile_column, tile_row)
         );",
    )
    .map_err(|e| e.to_string())?;

    if !exists {
        if let Some(meta) = init_meta {
            let bounds_str = format!(
                "{:.7},{:.7},{:.7},{:.7}",
                meta.bounds.west, meta.bounds.south, meta.bounds.east, meta.bounds.north
            );
            let center_str = format!(
                "{:.7},{:.7},{}",
                (meta.bounds.east + meta.bounds.west) / 2.0,
                (meta.bounds.north + meta.bounds.south) / 2.0,
                meta.min_zoom
            );
            let entries: Vec<(&str, String)> = vec![
                ("name", meta.name.clone()),
                ("type", "baselayer".to_string()),
                ("version", "1.0".to_string()),
                ("description", meta.description.clone().unwrap_or_default()),
                ("format", meta.format.clone()),
                ("bounds", bounds_str),
                ("center", center_str),
                ("minzoom", meta.min_zoom.to_string()),
                ("maxzoom", meta.max_zoom.to_string()),
                ("attribution", meta.attribution.clone().unwrap_or_default()),
            ];
            for (k, v) in entries {
                conn.execute(
                    "INSERT OR REPLACE INTO metadata (name, value) VALUES (?1, ?2)",
                    params![k, v],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(conn)
}

/// 写入指定 zoom 的所有瓦片到 mbtiles。文件不存在时按 init_meta 初始化。
/// `tile_files` key 为 (x, y) XYZ 坐标。
pub fn append_zoom_to_mbtiles(
    output: &Path,
    zoom: u8,
    tile_files: &HashMap<(u32, u32), TileSource>,
    init_meta: Option<&PackMetadata>,
) -> Result<u64, String> {
    let mut conn = open_mbtiles(output, init_meta)?;
    // 更新 minzoom/maxzoom
    {
        let cur_min: Option<i64> = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM metadata WHERE name='minzoom'",
                [],
                |r| r.get(0),
            )
            .ok();
        let cur_max: Option<i64> = conn
            .query_row(
                "SELECT CAST(value AS INTEGER) FROM metadata WHERE name='maxzoom'",
                [],
                |r| r.get(0),
            )
            .ok();
        let new_min = cur_min.map(|c| c.min(zoom as i64)).unwrap_or(zoom as i64);
        let new_max = cur_max.map(|c| c.max(zoom as i64)).unwrap_or(zoom as i64);
        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('minzoom', ?1)",
            params![new_min.to_string()],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO metadata (name, value) VALUES ('maxzoom', ?1)",
            params![new_max.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }

    let is_pbf = init_meta
        .map(|m| m.format == "pbf")
        .unwrap_or_else(|| {
            // 已存在的库：查 metadata.format
            conn.query_row(
                "SELECT value FROM metadata WHERE name='format'",
                [],
                |r| r.get::<_, String>(0),
            )
            .map(|s| s == "pbf")
            .unwrap_or(false)
        });

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut sample_layers: Vec<String> = Vec::new();
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) \
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| e.to_string())?;
        for ((x, y), source) in tile_files {
            let bytes = match read_tile_bytes(source) {
                Ok(b) if !b.is_empty() => b,
                _ => continue,
            };
            // MVT/PBF 在 MBTiles 1.3 规范里要求 tile_data 为 gzip 压缩的 protobuf
            let stored = if is_pbf {
                if sample_layers.is_empty() {
                    sample_layers = extract_mvt_layer_names(&bytes);
                }
                gzip_if_needed(bytes)?
            } else {
                bytes
            };
            let tms_row = xyz_to_tms_row(zoom, *y);
            stmt.execute(params![zoom as i64, *x as i64, tms_row as i64, stored])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    // 矢量瓦片库写入 / 更新 metadata.json (vector_layers)
    if is_pbf {
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='json'",
                [],
                |r| r.get(0),
            )
            .ok();
        if existing.is_none() && !sample_layers.is_empty() {
            // 极简 vector_layers 描述：QGIS 会基于此识别 source-layer
            let layers_json: Vec<String> = sample_layers
                .iter()
                .map(|n| {
                    format!(
                        "{{\"id\":{},\"description\":\"\",\"minzoom\":0,\"maxzoom\":22,\"fields\":{{}}}}",
                        serde_json::to_string(n).unwrap_or_else(|_| "\"\"".to_string())
                    )
                })
                .collect();
            let json_value = format!("{{\"vector_layers\":[{}]}}", layers_json.join(","));
            conn.execute(
                "INSERT OR REPLACE INTO metadata (name, value) VALUES ('json', ?1)",
                params![json_value],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    let size = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(size)
}

// ===== GeoPackage Raster =====

fn open_gpkg(path: &Path, init_meta: Option<&PackMetadata>) -> Result<Connection, String> {
    let exists = path.exists();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;

    // GeoPackage 应用 ID + 用户版本（PRAGMA application_id = 'GPKG' = 0x47504B47, user_version = 10300）
    conn.execute_batch("PRAGMA application_id = 1196444487; PRAGMA user_version = 10300;")
        .map_err(|e| e.to_string())?;

    // 核心表
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
            srs_name TEXT NOT NULL,
            srs_id INTEGER NOT NULL PRIMARY KEY,
            organization TEXT NOT NULL,
            organization_coordsys_id INTEGER NOT NULL,
            definition TEXT NOT NULL,
            description TEXT
         );
         CREATE TABLE IF NOT EXISTS gpkg_contents (
            table_name TEXT NOT NULL PRIMARY KEY,
            data_type TEXT NOT NULL,
            identifier TEXT UNIQUE,
            description TEXT DEFAULT '',
            last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            min_x DOUBLE,
            min_y DOUBLE,
            max_x DOUBLE,
            max_y DOUBLE,
            srs_id INTEGER,
            CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
         );
         CREATE TABLE IF NOT EXISTS gpkg_tile_matrix_set (
            table_name TEXT NOT NULL PRIMARY KEY,
            srs_id INTEGER NOT NULL,
            min_x DOUBLE NOT NULL,
            min_y DOUBLE NOT NULL,
            max_x DOUBLE NOT NULL,
            max_y DOUBLE NOT NULL,
            CONSTRAINT fk_gtms_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
            CONSTRAINT fk_gtms_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id)
         );
         CREATE TABLE IF NOT EXISTS gpkg_tile_matrix (
            table_name TEXT NOT NULL,
            zoom_level INTEGER NOT NULL,
            matrix_width INTEGER NOT NULL,
            matrix_height INTEGER NOT NULL,
            tile_width INTEGER NOT NULL,
            tile_height INTEGER NOT NULL,
            pixel_x_size DOUBLE NOT NULL,
            pixel_y_size DOUBLE NOT NULL,
            CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level),
            CONSTRAINT fk_tmm_table_name FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
         );",
    )
    .map_err(|e| e.to_string())?;

    if !exists {
        // 必须的 srs 行
        conn.execute_batch(
            "INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES \
             ('Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', NULL);
             INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES \
             ('Undefined geographic SRS', 0, 'NONE', 0, 'undefined', NULL);
             INSERT OR IGNORE INTO gpkg_spatial_ref_sys VALUES \
             ('WGS 84 / Pseudo-Mercator', 3857, 'EPSG', 3857, \
              'PROJCS[\"WGS 84 / Pseudo-Mercator\",GEOGCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563]],PRIMEM[\"Greenwich\",0],UNIT[\"degree\",0.0174532925199433]],PROJECTION[\"Mercator_1SP\"],PARAMETER[\"central_meridian\",0],PARAMETER[\"scale_factor\",1],PARAMETER[\"false_easting\",0],PARAMETER[\"false_northing\",0],UNIT[\"metre\",1]]', \
              NULL);",
        )
        .map_err(|e| e.to_string())?;
    }

    if !exists {
        if let Some(meta) = init_meta {
            // Web Mercator 整球范围
            let extent_m = 20037508.342789244;
            let (min_x, min_y, max_x, max_y) = lonlat_bbox_to_mercator(&meta.bounds);
            conn.execute(
                "INSERT OR REPLACE INTO gpkg_contents \
                 (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id) \
                 VALUES ('tiles', 'tiles', ?1, ?2, ?3, ?4, ?5, ?6, 3857)",
                params![
                    meta.name,
                    meta.description.clone().unwrap_or_default(),
                    min_x,
                    min_y,
                    max_x,
                    max_y,
                ],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO gpkg_tile_matrix_set \
                 (table_name, srs_id, min_x, min_y, max_x, max_y) \
                 VALUES ('tiles', 3857, ?1, ?2, ?3, ?4)",
                params![-extent_m, -extent_m, extent_m, extent_m],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "CREATE TABLE IF NOT EXISTS tiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    zoom_level INTEGER NOT NULL,
                    tile_column INTEGER NOT NULL,
                    tile_row INTEGER NOT NULL,
                    tile_data BLOB NOT NULL,
                    UNIQUE (zoom_level, tile_column, tile_row)
                 )",
                [],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(conn)
}

fn lonlat_bbox_to_mercator(b: &TileBounds) -> (f64, f64, f64, f64) {
    let to_merc = |lon: f64, lat: f64| -> (f64, f64) {
        let r = 6378137.0_f64;
        let x = lon.to_radians() * r;
        let y = ((std::f64::consts::FRAC_PI_4 + lat.to_radians() / 2.0).tan()).ln() * r;
        (x, y)
    };
    let (min_x, min_y) = to_merc(b.west, b.south);
    let (max_x, max_y) = to_merc(b.east, b.north);
    (min_x, min_y, max_x, max_y)
}

/// 写入指定 zoom 的所有瓦片到 GPKG。
pub fn append_zoom_to_gpkg(
    output: &Path,
    zoom: u8,
    tile_files: &HashMap<(u32, u32), TileSource>,
    init_meta: Option<&PackMetadata>,
) -> Result<u64, String> {
    // GeoPackage 标准的 raster tiles 表不支持矢量瓦片（QGIS 会按栅格尝试解码 PBF 失败）。
    // OGC 还有「Vector Tiles Extension」可承载 PBF，但实现复杂且 QGIS 支持不完整。
    // 当前版本对矢量数据建议改用 MBTiles 或原始 PBF 目录。
    if let Some(m) = init_meta {
        if m.format == "pbf" {
            return Err(
                "GeoPackage 当前版本不支持 MVT/PBF 矢量瓦片，请改用 MBTiles 或 PBF 目录格式".to_string(),
            );
        }
    }
    let mut conn = open_gpkg(output, init_meta)?;

    // tile_matrix 行（每 zoom 一行）
    let extent_m = 20037508.342789244_f64;
    let matrix_size: u64 = 1u64 << zoom;
    let pixel_size = (extent_m * 2.0) / (matrix_size as f64) / 256.0;
    conn.execute(
        "INSERT OR REPLACE INTO gpkg_tile_matrix \
         (table_name, zoom_level, matrix_width, matrix_height, tile_width, tile_height, pixel_x_size, pixel_y_size) \
         VALUES ('tiles', ?1, ?2, ?2, 256, 256, ?3, ?3)",
        params![zoom as i64, matrix_size as i64, pixel_size],
    )
    .map_err(|e| e.to_string())?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) \
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| e.to_string())?;
        for ((x, y), source) in tile_files {
            let bytes = match read_tile_bytes(source) {
                Ok(b) if !b.is_empty() => b,
                _ => continue,
            };
            // GeoPackage 行号采用 XYZ（左上原点）
            stmt.execute(params![zoom as i64, *x as i64, *y as i64, bytes])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let size = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    Ok(size)
}

/// 推断瓦片文件实际格式（基于第一个非空瓦片的魔数）
pub fn detect_tile_format(tile_files: &HashMap<(u32, u32), TileSource>) -> String {
    for source in tile_files.values() {
        if let Ok(bytes) = source.bytes() {
            if !bytes.is_empty() {
                return detect_format(&bytes).to_string();
            }
        }
    }
    "png".to_string()
}

/// 推断瓦片格式，允许调用方传入外部提示（如从 ExportFormat / URL 扩展名）。
/// 提示高于魔数推断（默认 fallback 仅返回 "png"，对 MVT/PBF 会误判）。
pub fn detect_tile_format_with_hint(
    tile_files: &HashMap<(u32, u32), TileSource>,
    hint: Option<&str>,
) -> String {
    if let Some(h) = hint {
        let h = h.to_lowercase();
        if matches!(h.as_str(), "pbf" | "mvt" | "png" | "jpg" | "jpeg" | "webp" | "tif" | "tiff") {
            // 规范化
            return match h.as_str() {
                "jpeg" => "jpg".to_string(),
                "mvt" => "pbf".to_string(),
                "tiff" => "tif".to_string(),
                _ => h,
            };
        }
    }
    detect_tile_format(tile_files)
}

/// 不拼接、不重编码，直接把下载下来的瓦片字节写入 {save_dir}/{z}/{x}/{y}.<ext>。
/// 返回本次写入的总字节数。适用于原始瓦片目录 / MVT PBF 输出。
/// 瓦片源若为文件路径走 `std::fs::copy`，缓存命中的内存字节走 `std::fs::write`。
pub fn write_raw_tiles_folder(
    save_dir: &Path,
    z: u8,
    tile_files: &HashMap<(u32, u32), TileSource>,
    extension: &str, // 不带点，如 "pbf" / "png" / "jpg"
) -> Result<u64, String> {
    let ext = extension.trim_start_matches('.');
    let z_dir = save_dir.join(z.to_string());
    std::fs::create_dir_all(&z_dir).map_err(|e| format!("创建目录失败 {}: {}", z_dir.display(), e))?;
    let mut total: u64 = 0;
    for ((x, y), source) in tile_files.iter() {
        let x_dir = z_dir.join(x.to_string());
        std::fs::create_dir_all(&x_dir).map_err(|e| format!("创建目录失败 {}: {}", x_dir.display(), e))?;
        let dst = if ext.is_empty() {
            x_dir.join(y.to_string())
        } else {
            x_dir.join(format!("{}.{}", y, ext))
        };
        match source.copy_to(&dst) {
            Ok(n) => total = total.saturating_add(n),
            Err(e) => {
                let src_str = source
                    .as_path()
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "<memory>".to_string());
                return Err(format!("写入瓦片失败 {} -> {}: {}", src_str, dst.display(), e));
            }
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 写入一个最小 PNG 字节串到文件，用于打包测试
    fn write_png(path: &Path) -> Vec<u8> {
        // 1x1 透明 PNG（标准最小 PNG）
        let bytes = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        fs::write(path, &bytes).expect("write png");
        bytes
    }

    fn sample_metadata() -> PackMetadata {
        PackMetadata {
            name: "test_source".to_string(),
            format: "png".to_string(),
            bounds: TileBounds {
                west: -180.0,
                south: -85.0,
                east: 180.0,
                north: 85.0,
            },
            min_zoom: 0,
            max_zoom: 2,
            attribution: Some("test".to_string()),
            description: Some("desc".to_string()),
        }
    }

    #[test]
    fn mbtiles_writes_metadata_and_tiles_with_tms_row() {
        let tmp = tempfile::tempdir().unwrap();
        let png_path = tmp.path().join("tile.png");
        write_png(&png_path);

        let mut tiles: HashMap<(u32, u32), TileSource> = HashMap::new();
        // z=2, y=0 (top in XYZ) → TMS row = 3
        tiles.insert((1, 0), TileSource::from_path(png_path.clone()));

        let mbtiles_path = tmp.path().join("out.mbtiles");
        let mut meta = sample_metadata();
        meta.min_zoom = 2;
        meta.max_zoom = 2;
        let size = append_zoom_to_mbtiles(&mbtiles_path, 2, &tiles, Some(&meta)).unwrap();
        assert!(size > 0);

        let conn = Connection::open(&mbtiles_path).unwrap();
        // metadata
        let name: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='name'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(name, "test_source");
        let minz: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='minzoom'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let maxz: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='maxzoom'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(minz, "2");
        assert_eq!(maxz, "2");

        // tile_row 必须为 TMS（XYZ y=0 在 z=2 应转换成 row=3）
        let tile_row: i64 = conn
            .query_row(
                "SELECT tile_row FROM tiles WHERE zoom_level=2 AND tile_column=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tile_row, 3);

        // 数据完整性
        let blob: Vec<u8> = conn
            .query_row(
                "SELECT tile_data FROM tiles WHERE zoom_level=2 AND tile_column=1 AND tile_row=3",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(blob.starts_with(&[0x89, 0x50, 0x4E, 0x47]));
    }

    #[test]
    fn mbtiles_appending_zoom_updates_min_max() {
        let tmp = tempfile::tempdir().unwrap();
        let png_path = tmp.path().join("tile.png");
        write_png(&png_path);
        let mut tiles: HashMap<(u32, u32), TileSource> = HashMap::new();
        tiles.insert((0, 0), TileSource::from_path(png_path.clone()));

        let mbtiles_path = tmp.path().join("out.mbtiles");
        let mut meta = sample_metadata();
        meta.min_zoom = 5;
        meta.max_zoom = 5;
        // zoom 5
        append_zoom_to_mbtiles(&mbtiles_path, 5, &tiles, Some(&meta)).unwrap();
        // zoom 8（不传 init_meta，模拟二次追加）
        append_zoom_to_mbtiles(&mbtiles_path, 8, &tiles, None).unwrap();

        let conn = Connection::open(&mbtiles_path).unwrap();
        let minz: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='minzoom'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let maxz: String = conn
            .query_row(
                "SELECT value FROM metadata WHERE name='maxzoom'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(minz, "5");
        assert_eq!(maxz, "8");
    }

    #[test]
    fn gpkg_creates_required_tables_and_xyz_row() {
        let tmp = tempfile::tempdir().unwrap();
        let png_path = tmp.path().join("tile.png");
        write_png(&png_path);
        let mut tiles: HashMap<(u32, u32), TileSource> = HashMap::new();
        // z=2, x=1, y=0 (XYZ, top edge)
        tiles.insert((1, 0), TileSource::from_path(png_path.clone()));

        let gpkg_path = tmp.path().join("out.gpkg");
        let meta = sample_metadata();
        let size = append_zoom_to_gpkg(&gpkg_path, 2, &tiles, Some(&meta)).unwrap();
        assert!(size > 0);

        let conn = Connection::open(&gpkg_path).unwrap();
        // application_id 必须为 GPKG 魔数
        let app_id: i64 = conn.query_row("PRAGMA application_id", [], |r| r.get(0)).unwrap();
        assert_eq!(app_id, 1196444487);
        let user_v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(user_v, 10300);

        // 必备 SRS 行
        let srs_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM gpkg_spatial_ref_sys WHERE srs_id IN (-1,0,3857)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(srs_count, 3);

        // gpkg_tile_matrix 行：matrix_size = 1<<2 = 4
        let mw: i64 = conn
            .query_row(
                "SELECT matrix_width FROM gpkg_tile_matrix WHERE table_name='tiles' AND zoom_level=2",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(mw, 4);

        // tile_row 必须按 XYZ 直接存（y=0），不做 TMS 反转
        let tile_row: i64 = conn
            .query_row(
                "SELECT tile_row FROM tiles WHERE zoom_level=2 AND tile_column=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tile_row, 0);
    }

    #[test]
    fn detect_tile_format_recognizes_png_jpg_webp() {
        let tmp = tempfile::tempdir().unwrap();
        let png = tmp.path().join("a.bin");
        write_png(&png);
        let mut tiles: HashMap<(u32, u32), TileSource> = HashMap::new();
        tiles.insert((0, 0), TileSource::from_path(png));
        assert_eq!(detect_tile_format(&tiles), "png");

        // jpg 魔数
        let jpg = tmp.path().join("b.bin");
        fs::write(&jpg, &[0xFF, 0xD8, 0xFF, 0xE0, 0x00]).unwrap();
        let mut t2: HashMap<(u32, u32), TileSource> = HashMap::new();
        t2.insert((0, 0), TileSource::from_path(jpg));
        assert_eq!(detect_tile_format(&t2), "jpg");

        // webp 魔数
        let webp = tmp.path().join("c.bin");
        let mut buf = b"RIFF".to_vec();
        buf.extend_from_slice(&[0u8; 4]);
        buf.extend_from_slice(b"WEBP");
        fs::write(&webp, &buf).unwrap();
        let mut t3: HashMap<(u32, u32), TileSource> = HashMap::new();
        t3.insert((0, 0), TileSource::from_path(webp));
        assert_eq!(detect_tile_format(&t3), "webp");

        // Issue #26：Bytes 变体应同样被 detect_tile_format 识别（不写盘）
        let mut t4: HashMap<(u32, u32), TileSource> = HashMap::new();
        let png_bytes = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        t4.insert((0, 0), TileSource::from_bytes(png_bytes));
        assert_eq!(detect_tile_format(&t4), "png");
    }

    #[test]
    fn lonlat_bbox_to_mercator_global() {
        let b = TileBounds {
            west: -180.0,
            south: -85.0511287798066,
            east: 180.0,
            north: 85.0511287798066,
        };
        let (min_x, min_y, max_x, max_y) = lonlat_bbox_to_mercator(&b);
        let extent = 20037508.342789244_f64;
        assert!((min_x + extent).abs() < 1e-3);
        assert!((max_x - extent).abs() < 1e-3);
        assert!((min_y + extent).abs() < 1.0);
        assert!((max_y - extent).abs() < 1.0);
    }
}
