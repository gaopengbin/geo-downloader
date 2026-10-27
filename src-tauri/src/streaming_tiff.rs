//! 流式 GeoTIFF 写入器
//! 逐行写入瓦片行，内存仅需一行瓦片宽度，支持超大图像导出。
//! 支持 RGB（3通道）和 RGBA（4通道，多边形裁剪时使用）。
//! M5: strip 内瓦片解码使用 rayon 并行，8核机器加速 4-6×。
//! Issue #27: 串行遍历 strip + 每 strip 内 rayon 并行解码/压缩，
//!          writer 线程异步落盘实现 IO/CPU 重叠。

use crate::config::TILE_SIZE;
use crate::merger::{self, PolygonPoint, TileSource};
use crate::settings::SettingsManager;
use crate::tile::{TileBounds, bounds_to_mercator};
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::{Write, Seek, SeekFrom, BufWriter};
use std::path::Path;

/// 读取 settings 中的流水线缓冲 MB；读取失败或字段缺失时回落 64。
fn export_buffer_bytes() -> u64 {
    let mb = SettingsManager::new()
        .and_then(|m| m.get())
        .map(|s| s.export_buffer_mb as u64)
        .unwrap_or(64);
    mb.max(1) * 1024 * 1024
}

/// 根据 strip 字节数与总 budget 算出 bounded channel 槽位数。
/// 保证至少 1 槽、最多 256 槽（超过 256 后的加速收益递减，反而增加线程调度开销）。
fn pipeline_slots(strip_byte_size: u64, budget_bytes: u64, num_strips: u32) -> usize {
    let raw = (budget_bytes / strip_byte_size.max(1)).max(1).min(256) as usize;
    raw.min(num_strips.max(1) as usize)
}

/// 计算导出网格尺寸 (cols, rows, width_px, height_px)，并在入口拦截非法输入。
/// 默认导出走 streaming 路径，这里返回 `Err` 而非裸算术：坐标反转 (x_max < x_min，
/// 如反经线/swapped bounds) 会触发 u32 减法 panic；超大区域 `cols * TILE_SIZE` 会
/// u32 乘法溢出 → 尺寸错乱写出损坏文件。返回 Err 让上层报"流式导出失败"而非崩溃/损坏。
pub(crate) fn grid_dims(
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
) -> Result<(u32, u32, u32, u32), String> {
    if x_max < x_min || y_max < y_min {
        return Err(format!(
            "无效的瓦片范围: x[{}..{}] y[{}..{}]",
            x_min, x_max, y_min, y_max
        ));
    }
    let cols = x_max - x_min + 1;
    let rows = y_max - y_min + 1;
    let width = cols
        .checked_mul(TILE_SIZE)
        .ok_or_else(|| format!("导出宽度溢出: {} 列瓦片超出上限", cols))?;
    let height = rows
        .checked_mul(TILE_SIZE)
        .ok_or_else(|| format!("导出高度溢出: {} 行瓦片超出上限", rows))?;
    Ok((cols, rows, width, height))
}

/// LZW 压缩一个 strip（TIFF 规范：MSB 位序，最小码长 8，early code size switch）
fn lzw_compress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut encoder = weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8);
    encoder.encode(data).map_err(|e| format!("LZW 压缩失败: {}", e))
}

/// Deflate 压缩一个 strip（TIFF Compression=8，zlib 封装）
fn deflate_compress(data: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).map_err(|e| format!("Deflate 压缩失败: {}", e))?;
    encoder.finish().map_err(|e| format!("Deflate 压缩失败: {}", e))
}

/// 压缩 strip 数据，返回 (compressed_data, tiff_compression_tag)
fn compress_strip(data: &[u8], compression: &str) -> Result<(Vec<u8>, u64), String> {
    match compression {
        "lzw" => Ok((lzw_compress(data)?, 5)),
        "deflate" => Ok((deflate_compress(data)?, 8)),
        _ => Ok((data.to_vec(), 1)), // none: 无压缩
    }
}

/// 流式合并瓦片并直接写入 GeoTIFF 文件
/// 内存占用上限: settings.export_buffer_mb（默认 64 MB），跨 strip 并行
/// 支持多边形裁剪：传入 polygons 后自动切换 RGBA 模式，多边形外像素透明
pub fn merge_and_export_streaming(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    compression: &str,
    polygons: Option<&[Vec<PolygonPoint>]>,
) -> Result<u64, String> {
    merge_and_export_streaming_with_budget(
        tile_files, x_min, y_min, x_max, y_max,
        bounds, save_path, compression, polygons,
        export_buffer_bytes(),
    )
}

/// 与 [`merge_and_export_streaming`] 等价，但显式注入并行流水线缓冲（字节）。
/// 用于单元测试比对不同 budget 的字节级输出一致性。
pub fn merge_and_export_streaming_with_budget(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    compression: &str,
    polygons: Option<&[Vec<PolygonPoint>]>,
    budget_bytes: u64,
) -> Result<u64, String> {
    let (_cols, rows, width, height) = grid_dims(x_min, y_min, x_max, y_max)?;
    let rows_per_strip = TILE_SIZE;
    let num_strips = rows; // 每行瓦片 = 一个 strip

    let has_mask = polygons.is_some();
    let channels: u32 = if has_mask { 4 } else { 3 };

    // 预计算多边形像素坐标环（复用 merger 的 mercator_y）
    let pixel_rings: Vec<Vec<(i32, i32)>> = if let Some(polys) = polygons {
        let lng_span = bounds.east - bounds.west;
        let merc_north = merger::mercator_y(bounds.north);
        let merc_south = merger::mercator_y(bounds.south);
        let merc_span = merc_north - merc_south;
        polys.iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| {
                        let x = ((p.lng - bounds.west) / lng_span * width as f64) as i32;
                        let y = ((merc_north - merger::mercator_y(p.lat)) / merc_span * height as f64) as i32;
                        (x, y)
                    })
                    .collect()
            })
            .filter(|ring: &Vec<(i32, i32)>| ring.len() >= 3)
            .collect()
    } else {
        Vec::new()
    };

    // 用 u64 计算字节大小，防止 u32 溢出
    let strip_byte_size_u64 = width as u64 * rows_per_strip as u64 * channels as u64;

    let file = std::fs::File::create(save_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut w = BufWriter::new(file);

    // ===== 1. 写 BigTIFF Header =====
    // Little-endian, version=43, offset_size=8
    w.write_all(b"II").map_err(e2s)?;           // byte order
    write_u16(&mut w, 43)?;                      // BigTIFF version
    write_u16(&mut w, 8)?;                       // offset byte size
    write_u16(&mut w, 0)?;                       // reserved
    let ifd_offset_pos = stream_pos(&mut w)?;
    write_u64(&mut w, 0)?;                       // IFD offset placeholder (8 bytes)

    // ===== 2. 流水线：strip 内 rayon 并行 + writer 线程异步落盘 =====
    let strip_byte_size = strip_byte_size_u64 as usize;
    let slot_count = pipeline_slots(strip_byte_size_u64, budget_bytes, num_strips);

    let (tx, rx) = std::sync::mpsc::sync_channel::<(u32, Vec<u8>)>(slot_count);

    let writer_handle = std::thread::spawn(move || -> Result<(BufWriter<std::fs::File>, Vec<u64>, Vec<u64>), String> {
        let mut strip_offsets: Vec<u64> = vec![0; num_strips as usize];
        let mut strip_counts: Vec<u64> = vec![0; num_strips as usize];
        let mut pending: std::collections::BTreeMap<u32, Vec<u8>> = std::collections::BTreeMap::new();
        let mut next_expected: u32 = 0;

        while let Ok((idx, compressed)) = rx.recv() {
            pending.insert(idx, compressed);
            // 顺序冲刷：尽可能多地写出已就位的连续 strip
            while let Some(bytes) = pending.remove(&next_expected) {
                let offset = stream_pos(&mut w)?;
                w.write_all(&bytes).map_err(e2s)?;
                strip_offsets[next_expected as usize] = offset;
                strip_counts[next_expected as usize] = bytes.len() as u64;
                next_expected += 1;
            }
        }
        // tx 已全部 drop，说明生产者结束；若还有残留说明生产者出错/缺席
        if next_expected != num_strips {
            return Err(format!(
                "写入线程提前退出：期望 {} 个 strip，仅写入 {}",
                num_strips, next_expected
            ));
        }
        Ok((w, strip_offsets, strip_counts))
    });

    let channels_u = channels as usize;
    let width_u = width as usize;

    // 生产者：串行遍历 strip，每个 strip 内部 rayon 并行解码瓦片。
    // sync_channel 实现 IO/CPU 重叠；同一时刻仅 1 个 strip 缓冲在内存中，避免 OOM。
    let producer_result: Result<(), String> = (|| {
      for strip_idx in 0..num_strips {
        let tile_y = y_min + strip_idx;

        let mut strip = if has_mask {
            vec![0u8; strip_byte_size]
        } else {
            vec![255u8; strip_byte_size]
        };

        let tile_xs: Vec<u32> = (x_min..=x_max).collect();
        let decoded: Vec<Option<(usize, image::RgbaImage)>> = tile_xs
            .par_iter()
            .map(|&tile_x| {
                let source = tile_files.get(&(tile_x, tile_y))?;
                let bytes = source.bytes().ok()?;
                let img = image::load_from_memory(&bytes).ok()?;
                let px = ((tile_x - x_min) * TILE_SIZE) as usize;
                Some((px, img.to_rgba8()))
            })
            .collect();

        for item in &decoded {
            if let Some((px, rgb)) = item {
                let tile_w = rgb.width().min(TILE_SIZE) as usize;
                let tile_h = rgb.height().min(TILE_SIZE) as usize;
                let raw = rgb.as_raw();

                for row in 0..tile_h {
                    let src_start = row * rgb.width() as usize * 4;
                    for col in 0..tile_w {
                        let si = src_start + col * 4;
                        let di = row * width_u * channels_u + (px + col) * channels_u;
                        if si + 2 < raw.len() && di + channels_u - 1 < strip.len() {
                            strip[di] = raw[si];
                            strip[di + 1] = raw[si + 1];
                            strip[di + 2] = raw[si + 2];
                            if has_mask {
                                strip[di + 3] = raw[si + 3];
                                if raw[si + 3] == 0 { strip[di..di+3].fill(0); }
                            }
                        }
                    }
                }
            }
        }
        drop(decoded);

        if has_mask && !pixel_rings.is_empty() {
            let strip_y_start = (tile_y - y_min) * TILE_SIZE;
            for local_row in 0..TILE_SIZE {
                let global_y = (strip_y_start + local_row) as i32;
                let mut intersections: Vec<i32> = Vec::new();
                for ring in &pixel_rings {
                    let n = ring.len();
                    let mut j = n - 1;
                    for i in 0..n {
                        let (xi, yi) = ring[i];
                        let (xj, yj) = ring[j];
                        if (yi > global_y) != (yj > global_y) {
                            let x_int = (xj - xi) * (global_y - yi) / (yj - yi) + xi;
                            intersections.push(x_int);
                        }
                        j = i;
                    }
                }
                intersections.sort_unstable();

                // 构造本行 inside 掩码（与 DEM 路径一致），环外整像素清零。
                let mut inside = vec![false; width_u];
                let mut k = 0;
                while k + 1 < intersections.len() {
                    let x0 = (intersections[k].max(0) as usize).min(width_u);
                    let x1 = (intersections[k + 1].max(0) as usize).min(width_u);
                    for x in x0..x1 {
                        if x < inside.len() { inside[x] = true; }
                    }
                    k += 2;
                }

                let row_offset = local_row as usize * width_u * channels_u;
                for x in 0..width_u {
                    let di = row_offset + x * channels_u;
                    if di + channels_u - 1 >= strip.len() { continue; }
                    if inside[x] {
                        // Keep source coverage alpha inside the polygon, including real NoData.
                    } else {
                        // 环外：整像素清零（RGB+alpha），与内存版 mask_image_by_polygons 一致。
                        // 仅清 alpha 会残留整张外接矩形 RGB → 群友报告的「外接矩形/黑边里有数据」。
                        strip[di] = 0;
                        strip[di + 1] = 0;
                        strip[di + 2] = 0;
                        strip[di + 3] = 0;
                    }
                }
            }
        }

        let (compressed, _tag) = compress_strip(&strip, compression)?;
        tx.send((strip_idx, compressed))
            .map_err(|e| format!("发送 strip 失败: {}", e))?;
      }
      Ok(())
    })();

    drop(tx);

    let writer_res = writer_handle.join().map_err(|_| "写入线程异常退出".to_string())?;
    producer_result?;
    let (mut w, strip_offsets, strip_counts) = writer_res?;

    // ===== 3. 写入 IFD 所需的额外数据 =====
    // BitsPerSample: RGB=[8,8,8], RGBA=[8,8,8,8]
    let bps_inline: u64 = if has_mask {
        8u64 | (8u64 << 16) | (8u64 << 32) | (8u64 << 48)
    } else {
        8u64 | (8u64 << 16) | (8u64 << 32)
    };

    // XResolution, YResolution (72/1) — 1 RATIONAL = 8 bytes, BigTIFF inline
    let res_inline: u64 = 72u64 | (1u64 << 32);  // numerator=72, denominator=1

    // StripOffsets (LONG8 for BigTIFF)
    let strip_offsets_offset = stream_pos(&mut w)?;
    for &off in &strip_offsets {
        write_u64(&mut w, off)?;
    }

    // StripByteCounts (LONG8 for BigTIFF)
    let strip_counts_offset = stream_pos(&mut w)?;
    for &cnt in &strip_counts {
        write_u64(&mut w, cnt)?;
    }

    // BigTIFF: 当只有 1 个 strip 时，1×LONG8=8 字节 ≤8，规范要求内联到 value 字段，
    // 否则解析器会把外部偏移当作数据 → 文件损坏（单行瓦片导出场景）。
    let strip_offsets_field = if num_strips == 1 { strip_offsets[0] } else { strip_offsets_offset };
    let strip_counts_field = if num_strips == 1 { strip_counts[0] } else { strip_counts_offset };

    // GeoTIFF: 转换为 EPSG:3857 (Web Mercator) 米坐标
    let (west_m, south_m, east_m, north_m) = bounds_to_mercator(bounds);
    let x_res = (east_m - west_m) / width as f64;
    let y_res = (north_m - south_m) / height as f64;

    // ModelPixelScale [x_res, y_res, 0]
    let pixel_scale_offset = stream_pos(&mut w)?;
    write_f64(&mut w, x_res)?;
    write_f64(&mut w, y_res)?;
    write_f64(&mut w, 0.0)?;

    // ModelTiepoint [0, 0, 0, west_m, north_m, 0]
    let tiepoint_offset = stream_pos(&mut w)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, west_m)?;
    write_f64(&mut w, north_m)?;
    write_f64(&mut w, 0.0)?;

    // GeoKeyDirectory: EPSG:3857
    let geokeys_offset = stream_pos(&mut w)?;
    let geo_keys: [u16; 16] = [
        1, 1, 0, 3,
        1024, 0, 1, 1,       // GTModelTypeGeoKey = ModelTypeProjected
        1025, 0, 1, 1,       // GTRasterTypeGeoKey = RasterPixelIsArea
        3072, 0, 1, 3857,    // ProjectedCSTypeGeoKey = EPSG:3857
    ];
    for &k in &geo_keys {
        write_u16(&mut w, k)?;
    }

    // ===== 4. 写入 BigTIFF IFD =====
    let ifd_pos = stream_pos(&mut w)?;

    let num_entries: u64 = if has_mask { 16 } else { 15 };
    write_u64(&mut w, num_entries)?;

    let bps_count = channels as u64;
    let comp_tag: u64 = match compression { "lzw" => 5, "deflate" => 8, _ => 1 };

    // BigTIFF IFD entry: tag(2) + type(2) + count(8) + value/offset(8) = 20 bytes
    write_bigtiff_entry(&mut w, 256, 4, 1, width as u64)?;                          // ImageWidth
    write_bigtiff_entry(&mut w, 257, 4, 1, height as u64)?;                         // ImageLength
    write_bigtiff_entry(&mut w, 258, 3, bps_count, bps_inline)?;                    // BitsPerSample
    write_bigtiff_entry(&mut w, 259, 3, 1, comp_tag)?;                              // Compression
    write_bigtiff_entry(&mut w, 262, 3, 1, 2)?;                                     // PhotometricInterpretation = RGB
    write_bigtiff_entry(&mut w, 273, 16, num_strips as u64, strip_offsets_field)?;  // StripOffsets (LONG8)
    write_bigtiff_entry(&mut w, 277, 3, 1, channels as u64)?;                       // SamplesPerPixel
    write_bigtiff_entry(&mut w, 278, 4, 1, rows_per_strip as u64)?;                 // RowsPerStrip
    write_bigtiff_entry(&mut w, 279, 16, num_strips as u64, strip_counts_field)?;  // StripByteCounts (LONG8)
    write_bigtiff_entry(&mut w, 282, 5, 1, res_inline)?;                            // XResolution (inline 72/1)
    write_bigtiff_entry(&mut w, 283, 5, 1, res_inline)?;                            // YResolution (inline 72/1)
    write_bigtiff_entry(&mut w, 296, 3, 1, 2)?;                                     // ResolutionUnit = Inch
    if has_mask {
        write_bigtiff_entry(&mut w, 338, 3, 1, 2)?;                                 // ExtraSamples = Unassociated Alpha
    }
    // GeoTIFF tags (EPSG:3857)
    write_bigtiff_entry(&mut w, 33550, 12, 3, pixel_scale_offset)?;                 // ModelPixelScaleTag
    write_bigtiff_entry(&mut w, 33922, 12, 6, tiepoint_offset)?;                    // ModelTiepointTag
    write_bigtiff_entry(&mut w, 34735, 3, 16, geokeys_offset)?;                     // GeoKeyDirectoryTag (16 u16 values)

    write_u64(&mut w, 0)?; // next IFD offset = 0

    // ===== 5. 回填 IFD offset =====
    w.seek(SeekFrom::Start(ifd_offset_pos)).map_err(e2s)?;
    write_u64(&mut w, ifd_pos)?;

    w.flush().map_err(e2s)?;
    drop(w);

    let file_size = std::fs::metadata(save_path)
        .map(|m| m.len())
        .unwrap_or(0);
    
    // 验证 BigTIFF 文件头完整性
    validate_bigtiff_header(save_path, ifd_pos)?;
    
    Ok(file_size)
}

/// 验证 BigTIFF 文件头是否完整写入
fn validate_bigtiff_header(path: &Path, expected_ifd_pos: u64) -> Result<(), String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("验证失败: 无法打开文件: {}", e))?;
    let mut header = [0u8; 16];
    f.read_exact(&mut header).map_err(|e| format!("验证失败: 读取头部: {}", e))?;
    
    // byte order
    if &header[0..2] != b"II" {
        return Err("验证失败: 文件字节序标记无效".to_string());
    }
    // version 43 (BigTIFF)
    let version = u16::from_le_bytes([header[2], header[3]]);
    if version != 43 {
        return Err(format!("验证失败: TIFF 版本标记 {} 不是 BigTIFF (43)", version));
    }
    // IFD offset
    let ifd_offset = u64::from_le_bytes(header[8..16].try_into().unwrap());
    if ifd_offset != expected_ifd_pos {
        return Err(format!("验证失败: IFD 偏移量 {} 与预期 {} 不一致", ifd_offset, expected_ifd_pos));
    }
    Ok(())
}

// ===== 辅助函数 =====

fn e2s(e: impl std::fmt::Display) -> String { e.to_string() }

fn stream_pos<W: Seek>(w: &mut W) -> Result<u64, String> {
    w.stream_position().map_err(e2s)
}

fn write_u16<W: Write>(w: &mut W, v: u16) -> Result<(), String> {
    w.write_all(&v.to_le_bytes()).map_err(e2s)
}

fn write_f64<W: Write>(w: &mut W, v: f64) -> Result<(), String> {
    w.write_all(&v.to_le_bytes()).map_err(e2s)
}

fn write_u64<W: Write>(w: &mut W, v: u64) -> Result<(), String> {
    w.write_all(&v.to_le_bytes()).map_err(e2s)
}

/// BigTIFF IFD entry: tag(2) + type(2) + count(8) + value/offset(8) = 20 bytes
/// For count=1 with small types (SHORT/LONG), the value is stored inline in the 8-byte field.
fn write_bigtiff_entry<W: Write>(w: &mut W, tag: u16, typ: u16, count: u64, value: u64) -> Result<(), String> {
    write_u16(w, tag)?;
    write_u16(w, typ)?;
    write_u64(w, count)?;
    write_u64(w, value)
}

// ============================================================
// DEM 流式导出 (Float32 单波段 GeoTIFF, EPSG:4326)
// ============================================================

/// Terrarium 编码 PNG → Float32 高程矩阵（单瓦片）
/// 编码公式：elevation_m = (R * 256 + G + B / 256) - 32768
fn decode_terrarium_tile(png_bytes: &[u8]) -> Result<image::ImageBuffer<image::Rgb<u8>, Vec<u8>>, String> {
    let img = image::load_from_memory(png_bytes)
        .map_err(|e| format!("Terrarium 瓦片解码失败: {}", e))?;
    Ok(img.to_rgb8())
}

/// 流式合并 Terrarium 瓦片并直接写入 Float32 GeoTIFF (BigTIFF)
/// - 单波段 Float32 (BitsPerSample=32, SampleFormat=3 IEEEFP)
/// - 投影 EPSG:4326 (与 Terrarium 源切片网格一致，无需重投影)
/// - NoData = -9999.0 (写入 GDAL_NODATA tag 42113)
/// - 缺失瓦片填 NoData
/// - 可选多边形裁剪：环外像素强制为 NoData
pub fn merge_and_export_dem_streaming(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    compression: &str,
    polygons: Option<&[Vec<PolygonPoint>]>,
) -> Result<u64, String> {
    merge_and_export_dem_streaming_with_budget(
        tile_files, x_min, y_min, x_max, y_max,
        bounds, save_path, compression, polygons,
        export_buffer_bytes(),
    )
}

/// 与 [`merge_and_export_dem_streaming`] 等价，显式注入流水线缓冲（字节），供单测使用。
pub fn merge_and_export_dem_streaming_with_budget(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    compression: &str,
    polygons: Option<&[Vec<PolygonPoint>]>,
    budget_bytes: u64,
) -> Result<u64, String> {
    let (_cols, rows, width, height) = grid_dims(x_min, y_min, x_max, y_max)?;
    let rows_per_strip = TILE_SIZE;
    let num_strips = rows;
    const NODATA: f32 = -9999.0;

    // Float32 = 4 bytes/pixel, 单波段
    let strip_byte_size_u64 = width as u64 * rows_per_strip as u64 * 4;
    let strip_byte_size = strip_byte_size_u64 as usize;

    // 预计算多边形像素坐标环（与像素映射保持一致：经度等距 + 纬度等距）
    // 注：Terrarium 切片本身在 mercator 上等高，但输出 EPSG:4326 是简化处理；
    // 裁剪坐标必须与像素坐标系一致，否则会与栅格错位
    let pixel_rings: Vec<Vec<(i32, i32)>> = if let Some(polys) = polygons {
        let lng_span = bounds.east - bounds.west;
        let lat_span = bounds.north - bounds.south;
        polys.iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| {
                        let x = ((p.lng - bounds.west) / lng_span * width as f64) as i32;
                        let y = ((bounds.north - p.lat) / lat_span * height as f64) as i32;
                        (x, y)
                    })
                    .collect()
            })
            .filter(|ring: &Vec<(i32, i32)>| ring.len() >= 3)
            .collect()
    } else {
        Vec::new()
    };

    let file = std::fs::File::create(save_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let mut w = BufWriter::new(file);

    // ===== 1. BigTIFF Header =====
    w.write_all(b"II").map_err(e2s)?;
    write_u16(&mut w, 43)?;
    write_u16(&mut w, 8)?;
    write_u16(&mut w, 0)?;
    let ifd_offset_pos = stream_pos(&mut w)?;
    write_u64(&mut w, 0)?;

    // ===== 2. 流水线：strip 内 rayon 并行 + writer 线程异步落盘 =====
    let slot_count = pipeline_slots(strip_byte_size_u64, budget_bytes, num_strips);
    let (tx, rx) = std::sync::mpsc::sync_channel::<(u32, Vec<u8>)>(slot_count);

    let writer_handle = std::thread::spawn(move || -> Result<(BufWriter<std::fs::File>, Vec<u64>, Vec<u64>), String> {
        let mut strip_offsets: Vec<u64> = vec![0; num_strips as usize];
        let mut strip_counts: Vec<u64> = vec![0; num_strips as usize];
        let mut pending: std::collections::BTreeMap<u32, Vec<u8>> = std::collections::BTreeMap::new();
        let mut next_expected: u32 = 0;

        while let Ok((idx, compressed)) = rx.recv() {
            pending.insert(idx, compressed);
            while let Some(bytes) = pending.remove(&next_expected) {
                let offset = stream_pos(&mut w)?;
                w.write_all(&bytes).map_err(e2s)?;
                strip_offsets[next_expected as usize] = offset;
                strip_counts[next_expected as usize] = bytes.len() as u64;
                next_expected += 1;
            }
        }
        if next_expected != num_strips {
            return Err(format!(
                "写入线程提前退出：期望 {} 个 strip，仅写入 {}",
                num_strips, next_expected
            ));
        }
        Ok((w, strip_offsets, strip_counts))
    });

    let nodata_bytes = NODATA.to_le_bytes();
    let width_u = width as usize;

    let producer_result: Result<(), String> = (|| {
      for strip_idx in 0..num_strips {
        let tile_y = y_min + strip_idx;

        let mut strip = vec![0u8; strip_byte_size];
        for chunk in strip.chunks_exact_mut(4) {
            chunk.copy_from_slice(&nodata_bytes);
        }

        let tile_xs: Vec<u32> = (x_min..=x_max).collect();
        let decoded: Vec<Option<(usize, image::RgbImage)>> = tile_xs
            .par_iter()
            .map(|&tile_x| {
                let source = tile_files.get(&(tile_x, tile_y))?;
                let bytes = source.bytes().ok()?;
                let rgb = decode_terrarium_tile(&bytes).ok()?;
                let px = ((tile_x - x_min) * TILE_SIZE) as usize;
                Some((px, rgb))
            })
            .collect();

        for item in &decoded {
            if let Some((px, rgb)) = item {
                let tile_w = rgb.width().min(TILE_SIZE) as usize;
                let tile_h = rgb.height().min(TILE_SIZE) as usize;
                let raw = rgb.as_raw();

                for row in 0..tile_h {
                    let src_row_start = row * rgb.width() as usize * 3;
                    for col in 0..tile_w {
                        let si = src_row_start + col * 3;
                        if si + 2 >= raw.len() { continue; }
                        let r = raw[si] as f32;
                        let g = raw[si + 1] as f32;
                        let b = raw[si + 2] as f32;
                        let elev = (r * 256.0 + g + b / 256.0) - 32768.0;
                        let di = (row * width_u + (px + col)) * 4;
                        if di + 3 < strip.len() {
                            strip[di..di + 4].copy_from_slice(&elev.to_le_bytes());
                        }
                    }
                }
            }
        }
        drop(decoded);

        if !pixel_rings.is_empty() {
            let strip_y_start = (tile_y - y_min) * TILE_SIZE;
            for local_row in 0..TILE_SIZE {
                let global_y = (strip_y_start + local_row) as i32;

                let mut intersections: Vec<i32> = Vec::new();
                for ring in &pixel_rings {
                    let n = ring.len();
                    let mut j = n - 1;
                    for i in 0..n {
                        let (xi, yi) = ring[i];
                        let (xj, yj) = ring[j];
                        if (yi > global_y) != (yj > global_y) {
                            let x_int = (xj - xi) * (global_y - yi) / (yj - yi) + xi;
                            intersections.push(x_int);
                        }
                        j = i;
                    }
                }
                intersections.sort_unstable();

                let mut inside = vec![false; width_u];
                let mut k = 0;
                while k + 1 < intersections.len() {
                    let x0 = intersections[k].max(0).min(width as i32) as usize;
                    let x1 = intersections[k + 1].max(0).min(width as i32) as usize;
                    for x in x0..x1 {
                        if x < inside.len() { inside[x] = true; }
                    }
                    k += 2;
                }

                let row_offset = local_row as usize * width_u * 4;
                for x in 0..width_u {
                    if !inside[x] {
                        let di = row_offset + x * 4;
                        if di + 3 < strip.len() {
                            strip[di..di + 4].copy_from_slice(&nodata_bytes);
                        }
                    }
                }
            }
        }

        let (compressed, _) = compress_strip(&strip, compression)?;
        tx.send((strip_idx, compressed))
            .map_err(|e| format!("发送 strip 失败: {}", e))?;
      }
      Ok(())
    })();

    drop(tx);

    let writer_res = writer_handle.join().map_err(|_| "写入线程异常退出".to_string())?;
    producer_result?;
    let (mut w, strip_offsets, strip_counts) = writer_res?;

    // ===== 3. IFD 外数据 =====
    let res_inline: u64 = 72u64 | (1u64 << 32);

    let strip_offsets_offset = stream_pos(&mut w)?;
    for &off in &strip_offsets {
        write_u64(&mut w, off)?;
    }

    let strip_counts_offset = stream_pos(&mut w)?;
    for &cnt in &strip_counts {
        write_u64(&mut w, cnt)?;
    }

    // BigTIFF: 单 strip 时 8 字节 ≤8，必须内联（否则单行 DEM 导出损坏）。
    let strip_offsets_field = if num_strips == 1 { strip_offsets[0] } else { strip_offsets_offset };
    let strip_counts_field = if num_strips == 1 { strip_counts[0] } else { strip_counts_offset };

    // GeoTIFF: EPSG:4326 经纬度坐标系
    let lng_span = bounds.east - bounds.west;
    let lat_span = bounds.north - bounds.south;
    let x_res = lng_span / width as f64;
    let y_res = lat_span / height as f64;

    let pixel_scale_offset = stream_pos(&mut w)?;
    write_f64(&mut w, x_res)?;
    write_f64(&mut w, y_res)?;
    write_f64(&mut w, 0.0)?;

    let tiepoint_offset = stream_pos(&mut w)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, 0.0)?;
    write_f64(&mut w, bounds.west)?;
    write_f64(&mut w, bounds.north)?;
    write_f64(&mut w, 0.0)?;

    // GeoKeyDirectory: EPSG:4326 (Geographic)
    let geokeys_offset = stream_pos(&mut w)?;
    let geo_keys: [u16; 16] = [
        1, 1, 0, 3,
        1024, 0, 1, 2,       // GTModelTypeGeoKey = ModelTypeGeographic
        1025, 0, 1, 1,       // GTRasterTypeGeoKey = RasterPixelIsArea
        2048, 0, 1, 4326,    // GeographicTypeGeoKey = WGS84
    ];
    for &k in &geo_keys {
        write_u16(&mut w, k)?;
    }

    // GDAL_NODATA: 6 字节 ASCII "-9999\0"，count×1=6 ≤8，BigTIFF 规范要求内联到 value 字段
    // （原先外置导致 GDAL/QGIS 读不到 NoData，-9999 被当作真实高程）。
    let nodata_str = b"-9999\0";
    let mut nodata_buf = [0u8; 8];
    nodata_buf[..nodata_str.len()].copy_from_slice(nodata_str);
    let nodata_inline = u64::from_le_bytes(nodata_buf);

    // ===== 4. BigTIFF IFD =====
    let ifd_pos = stream_pos(&mut w)?;

    // 16 entries
    let num_entries: u64 = 16;
    write_u64(&mut w, num_entries)?;

    let comp_tag: u64 = match compression { "lzw" => 5, "deflate" => 8, _ => 1 };

    write_bigtiff_entry(&mut w, 256, 4, 1, width as u64)?;                          // ImageWidth
    write_bigtiff_entry(&mut w, 257, 4, 1, height as u64)?;                         // ImageLength
    write_bigtiff_entry(&mut w, 258, 3, 1, 32)?;                                    // BitsPerSample = 32 (inline)
    write_bigtiff_entry(&mut w, 259, 3, 1, comp_tag)?;                              // Compression
    write_bigtiff_entry(&mut w, 262, 3, 1, 1)?;                                     // Photometric = BlackIsZero
    write_bigtiff_entry(&mut w, 273, 16, num_strips as u64, strip_offsets_field)?; // StripOffsets (LONG8)
    write_bigtiff_entry(&mut w, 277, 3, 1, 1)?;                                     // SamplesPerPixel = 1
    write_bigtiff_entry(&mut w, 278, 4, 1, rows_per_strip as u64)?;                 // RowsPerStrip
    write_bigtiff_entry(&mut w, 279, 16, num_strips as u64, strip_counts_field)?;  // StripByteCounts (LONG8)
    write_bigtiff_entry(&mut w, 282, 5, 1, res_inline)?;                            // XResolution
    write_bigtiff_entry(&mut w, 283, 5, 1, res_inline)?;                            // YResolution
    write_bigtiff_entry(&mut w, 339, 3, 1, 3)?;                                     // SampleFormat = IEEEFP
    write_bigtiff_entry(&mut w, 33550, 12, 3, pixel_scale_offset)?;                 // ModelPixelScale
    write_bigtiff_entry(&mut w, 33922, 12, 6, tiepoint_offset)?;                    // ModelTiepoint
    write_bigtiff_entry(&mut w, 34735, 3, 16, geokeys_offset)?;                     // GeoKeyDirectory
    write_bigtiff_entry(&mut w, 42113, 2, nodata_str.len() as u64, nodata_inline)?; // GDAL_NODATA (inline)

    write_u64(&mut w, 0)?; // next IFD = 0

    // ===== 5. 回填 IFD offset =====
    w.seek(SeekFrom::Start(ifd_offset_pos)).map_err(e2s)?;
    write_u64(&mut w, ifd_pos)?;

    w.flush().map_err(e2s)?;
    drop(w);

    let file_size = std::fs::metadata(save_path)
        .map(|m| m.len())
        .unwrap_or(0);

    validate_bigtiff_header(save_path, ifd_pos)?;

    Ok(file_size)
}

// ============================================================
// Tests (Issue #27 跨 strip 并行流水线)
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};
    use std::sync::Arc;

    /// 生成一张 256×256 PNG 瓦片，每个像素 = (tx, ty, (tx+ty) & 0xFF)，
    /// 让不同 (tx, ty) 产生不同字节，便于发现行错位 bug。
    fn make_tile(tx: u32, ty: u32) -> Vec<u8> {
        let mut buf: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(TILE_SIZE, TILE_SIZE);
        let r = (tx & 0xFF) as u8;
        let g = (ty & 0xFF) as u8;
        let b = ((tx + ty) & 0xFF) as u8;
        for px in buf.pixels_mut() {
            *px = Rgb([r, g, b]);
        }
        let mut out = Vec::new();
        let dyn_img = image::DynamicImage::ImageRgb8(buf);
        dyn_img
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode png");
        out
    }

    fn make_tile_files(
        x_min: u32, y_min: u32, x_max: u32, y_max: u32,
    ) -> HashMap<(u32, u32), TileSource> {
        let mut map = HashMap::new();
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                map.insert((x, y), TileSource::Bytes(Arc::new(make_tile(x, y))));
            }
        }
        map
    }

    fn dummy_bounds() -> TileBounds {
        TileBounds { west: -10.0, south: -10.0, east: 10.0, north: 10.0 }
    }

    /// 生成一张纯色 256×256 PNG 瓦片（RGB 全非零，便于检测裁剪外是否残留数据）。
    fn make_solid_tile(r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut buf: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::new(TILE_SIZE, TILE_SIZE);
        for px in buf.pixels_mut() {
            *px = Rgb([r, g, b]);
        }
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(buf)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .expect("encode png");
        out
    }

    fn solid_tile_files(
        x_min: u32, y_min: u32, x_max: u32, y_max: u32, r: u8, g: u8, b: u8,
    ) -> HashMap<(u32, u32), TileSource> {
        let mut map = HashMap::new();
        for y in y_min..=y_max {
            for x in x_min..=x_max {
                map.insert((x, y), TileSource::Bytes(Arc::new(make_solid_tile(r, g, b))));
            }
        }
        map
    }

    /// 回归：多边形裁剪必须真正清除环外像素，而不是仅把 alpha 置 0 却保留 RGB。
    /// 群友报告「下载下来的是外接矩形，数据有黑边，黑边里有数据」——根因是流式
    /// 掩码只清 alpha、RGB 残留整张外接矩形影像。环外像素应整体清零 (0,0,0,0)。
    #[test]
    fn rgb_streaming_mask_zeroes_pixels_outside_polygon() {
        let tmp = tempfile::tempdir().unwrap();
        // 2×2 瓦片纯色 (50,100,150)，导出范围 west-10/south-10/east10/north10
        let tiles = solid_tile_files(0, 0, 1, 1, 50, 100, 150);
        let bounds = dummy_bounds();

        // 多边形 = 左上象限（lng[-10,0]、lat[0,10]）→ 像素方块 (0,0)-(256,256)
        let poly = vec![vec![
            PolygonPoint { lat: 10.0, lng: -10.0 },
            PolygonPoint { lat: 10.0, lng: 0.0 },
            PolygonPoint { lat: 0.0, lng: 0.0 },
            PolygonPoint { lat: 0.0, lng: -10.0 },
        ]];

        let path = tmp.path().join("mask.tif");
        // compression=none → strip 未压缩、紧跟 16 字节文件头连续排布，可直接按偏移读回
        merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 1, 1, &bounds, &path, "none", Some(&poly), 64 * 1024 * 1024,
        )
        .unwrap();

        let raw = std::fs::read(&path).unwrap();
        let width = 2 * TILE_SIZE as usize; // 512
        let strip_bytes = width * TILE_SIZE as usize * 4; // 一条未压缩 RGBA strip
        let px = |x: usize, y: usize| -> [u8; 4] {
            let strip_idx = y / TILE_SIZE as usize;
            let local_row = y % TILE_SIZE as usize;
            let off = 16 + strip_idx * strip_bytes + (local_row * width + x) * 4;
            [raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]
        };

        // 多边形内：保留真实影像且不透明
        assert_eq!(px(100, 100), [50, 100, 150, 255], "多边形内像素应保留影像且不透明");
        // 多边形外：必须整体清零，而非 RGB 残留 + alpha=0
        assert_eq!(
            px(400, 400), [0, 0, 0, 0],
            "多边形外像素必须清零；RGB 残留即「外接矩形/黑边里有数据」回归"
        );
    }

    /// 端到端：用群友「测试黑边一个圆.shp」的真实几何（92 顶点近似圆，WGS84，
    /// 巴西 lng≈-54.5 / lat≈-5.6）跑一遍裁剪导出。验证修复对真实凸多边形数据有效：
    /// 形状内保留影像、外接矩形四角必须清零（不残留 RGB）。
    #[test]
    fn rgb_streaming_mask_real_circle_shapefile() {
        // 真实顶点（lat, lng），取自用户上传的 shapefile，闭合环。
        let ring: Vec<PolygonPoint> = [
            (-5.613039, -54.545762), (-5.611840, -54.545720), (-5.610646, -54.545596),
            (-5.609464, -54.545390), (-5.608299, -54.545103), (-5.607156, -54.544736),
            (-5.606041, -54.544291), (-5.604960, -54.543770), (-5.603917, -54.543176),
            (-5.602918, -54.542512), (-5.601967, -54.541780), (-5.601068, -54.540984),
            (-5.600227, -54.540128), (-5.599447, -54.539216), (-5.598731, -54.538252),
            (-5.598084, -54.537242), (-5.597508, -54.536189), (-5.597006, -54.535099),
            (-5.596580, -54.533976), (-5.596233, -54.532828), (-5.595966, -54.531657),
            (-5.595781, -54.530472), (-5.595677, -54.529276), (-5.595656, -54.528076),
            (-5.595719, -54.526877), (-5.595863, -54.525686), (-5.596090, -54.524507),
            (-5.596397, -54.523347), (-5.596784, -54.522211), (-5.597248, -54.521104),
            (-5.597787, -54.520032), (-5.598399, -54.519000), (-5.599081, -54.518012),
            (-5.599829, -54.517074), (-5.600640, -54.516189), (-5.601511, -54.515363),
            (-5.602436, -54.514599), (-5.603412, -54.513900), (-5.604433, -54.513270),
            (-5.605496, -54.512712), (-5.606595, -54.512229), (-5.607724, -54.511823),
            (-5.608879, -54.511496), (-5.610053, -54.511249), (-5.611242, -54.511084),
            (-5.612439, -54.511001), (-5.613639, -54.511001), (-5.614837, -54.511084),
            (-5.616025, -54.511249), (-5.617200, -54.511496), (-5.618355, -54.511823),
            (-5.619484, -54.512229), (-5.620583, -54.512712), (-5.621645, -54.513270),
            (-5.622667, -54.513900), (-5.623643, -54.514599), (-5.624568, -54.515363),
            (-5.625438, -54.516189), (-5.626250, -54.517074), (-5.626998, -54.518012),
            (-5.627680, -54.519000), (-5.628292, -54.520032), (-5.628831, -54.521104),
            (-5.629295, -54.522211), (-5.629682, -54.523347), (-5.629989, -54.524507),
            (-5.630216, -54.525686), (-5.630360, -54.526877), (-5.630422, -54.528076),
            (-5.630402, -54.529276), (-5.630298, -54.530472), (-5.630112, -54.531657),
            (-5.629845, -54.532828), (-5.629498, -54.533976), (-5.629073, -54.535099),
            (-5.628571, -54.536189), (-5.627995, -54.537242), (-5.627347, -54.538252),
            (-5.626632, -54.539216), (-5.625852, -54.540128), (-5.625010, -54.540984),
            (-5.624112, -54.541780), (-5.623161, -54.542512), (-5.622162, -54.543176),
            (-5.621119, -54.543770), (-5.620037, -54.544291), (-5.618923, -54.544736),
            (-5.617780, -54.545103), (-5.616615, -54.545390), (-5.615433, -54.545596),
            (-5.614239, -54.545720), (-5.613039, -54.545762),
        ]
        .iter()
        .map(|&(lat, lng)| PolygonPoint { lat, lng })
        .collect();
        let poly = vec![ring];

        // 导出范围 = 圆的外接矩形；单瓦片纯色填充。
        let bounds = TileBounds {
            west: -54.545762, east: -54.511001, south: -5.630422, north: -5.595656,
        };
        let tiles = solid_tile_files(0, 0, 0, 0, 50, 100, 150);

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("circle.tif");
        merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 0, 0, &bounds, &path, "none", Some(&poly), 64 * 1024 * 1024,
        )
        .unwrap();

        let raw = std::fs::read(&path).unwrap();
        let width = TILE_SIZE as usize; // 256
        let px = |x: usize, y: usize| -> [u8; 4] {
            let off = 16 + (y * width + x) * 4;
            [raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]
        };

        // 圆心附近：保留影像且不透明
        assert_eq!(px(128, 128), [50, 100, 150, 255], "圆内像素应保留影像");
        // 外接矩形四角：必须清零（这正是用户看到的「黑边」位置）
        for (cx, cy) in [(2usize, 2usize), (253, 2), (2, 253), (253, 253)] {
            assert_eq!(
                px(cx, cy), [0, 0, 0, 0],
                "外接矩形角点 ({cx},{cy}) 必须清零；残留 RGB 即「黑边里有数据」"
            );
        }
    }

    /// 端到端：用群友「测试黑边一个多边形.shp」的真实几何（7 顶点凹多边形，WGS84）
    /// 模拟「拆分」模式——该要素用自己的 bbox 作导出范围、自己的环作裁剪。
    /// 验证修复对真实不规则多边形有效：内部保留影像、外接矩形四角清零。
    #[test]
    fn rgb_streaming_mask_real_polygon_shapefile() {
        // 真实顶点（lat, lng），闭合环。
        let ring: Vec<PolygonPoint> = [
            (-5.611263, -54.539796), (-5.605561, -54.532162), (-5.605561, -54.523437),
            (-5.612198, -54.520633), (-5.618679, -54.518888), (-5.622917, -54.524248),
            (-5.623633, -54.538144), (-5.611263, -54.539796),
        ]
        .iter()
        .map(|&(lat, lng)| PolygonPoint { lat, lng })
        .collect();
        let poly = vec![ring];

        // 导出范围 = 多边形自己的外接矩形（拆分模式：每个要素用各自 bbox）。
        let bounds = TileBounds {
            west: -54.539796, east: -54.518888, south: -5.623633, north: -5.605561,
        };
        let tiles = solid_tile_files(0, 0, 0, 0, 200, 60, 30);

        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("polygon.tif");
        merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 0, 0, &bounds, &path, "none", Some(&poly), 64 * 1024 * 1024,
        )
        .unwrap();

        let raw = std::fs::read(&path).unwrap();
        let width = TILE_SIZE as usize; // 256
        let px = |x: usize, y: usize| -> [u8; 4] {
            let off = 16 + (y * width + x) * 4;
            [raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]
        };

        // 稳健内部点（由 masker 精确变换 + 射线法求得，四邻均在环内）
        assert_eq!(px(92, 8), [200, 60, 30, 255], "多边形内像素应保留影像");
        // 外接矩形四角：必须清零
        for (cx, cy) in [(2usize, 2usize), (253, 2), (2, 253), (253, 253)] {
            assert_eq!(
                px(cx, cy), [0, 0, 0, 0],
                "外接矩形角点 ({cx},{cy}) 必须清零；残留 RGB 即「黑边里有数据」"
            );
        }
    }

    /// 不同流水线 budget 必须输出字节级一致的 GeoTIFF。
    /// 这条用例同时覆盖 K=1（纯顺序）与 K=N（最大并行）的边界。
    #[test]
    fn rgb_pipeline_byte_identical_under_varying_budgets() {
        let tmp = tempfile::tempdir().unwrap();
        let tiles = make_tile_files(0, 0, 2, 3); // 3×4 = 12 strip
        let bounds = dummy_bounds();

        let p1 = tmp.path().join("budget_tiny.tif");
        let p2 = tmp.path().join("budget_large.tif");

        // 极小 budget → slot=1，等价于单 strip 顺序
        let s1 = merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 2, 3, &bounds, &p1, "lzw", None, 1,
        ).unwrap();
        // 大 budget → slot 取 num_strips 上限
        let s2 = merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 2, 3, &bounds, &p2, "lzw", None, 256 * 1024 * 1024,
        ).unwrap();

        assert_eq!(s1, s2, "文件大小必须一致");
        let b1 = std::fs::read(&p1).unwrap();
        let b2 = std::fs::read(&p2).unwrap();
        assert_eq!(b1, b2, "不同 budget 下 GeoTIFF 字节流不一致 → strip 顺序错乱");
    }

    /// DEM 路径同样验证：不同 budget 输出字节级一致。
    #[test]
    fn dem_pipeline_byte_identical_under_varying_budgets() {
        let tmp = tempfile::tempdir().unwrap();
        let tiles = make_tile_files(0, 0, 1, 2);
        let bounds = dummy_bounds();

        let p1 = tmp.path().join("dem_tiny.tif");
        let p2 = tmp.path().join("dem_large.tif");

        let s1 = merge_and_export_dem_streaming_with_budget(
            &tiles, 0, 0, 1, 2, &bounds, &p1, "deflate", None, 1,
        ).unwrap();
        let s2 = merge_and_export_dem_streaming_with_budget(
            &tiles, 0, 0, 1, 2, &bounds, &p2, "deflate", None, 256 * 1024 * 1024,
        ).unwrap();

        assert_eq!(s1, s2);
        assert_eq!(std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap());
    }

    #[test]
    fn pipeline_slots_clamps_to_strips_and_cap() {
        // strip = 1MB，budget = 64MB → 64 槽，但只有 5 个 strip → 5
        assert_eq!(pipeline_slots(1 * 1024 * 1024, 64 * 1024 * 1024, 5), 5);
        // budget < strip → 至少 1
        assert_eq!(pipeline_slots(10 * 1024 * 1024, 1024, 100), 1);
        // 上限 256（防止线程调度开销吃掉收益）
        assert_eq!(pipeline_slots(1024, 1024 * 1024 * 1024, 10_000), 256);
    }

    /// 缺瓦片场景：HashMap 缺少部分坐标 → 对应位置应保持初始白色背景，
    /// 不同 budget 仍需字节一致（验证我们没有跨 strip 串扰）。
    #[test]
    fn rgb_pipeline_missing_tiles_consistent() {
        let tmp = tempfile::tempdir().unwrap();
        let mut tiles = make_tile_files(0, 0, 1, 1);
        tiles.remove(&(0, 0)); // 抠掉一块
        let bounds = dummy_bounds();

        let p1 = tmp.path().join("miss_k1.tif");
        let p2 = tmp.path().join("miss_kn.tif");

        merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 1, 1, &bounds, &p1, "none", None, 1,
        ).unwrap();
        merge_and_export_streaming_with_budget(
            &tiles, 0, 0, 1, 1, &bounds, &p2, "none", None, 64 * 1024 * 1024,
        ).unwrap();

        assert_eq!(std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap());
    }
}
