//! 流式 GeoTIFF 写入器
//! 逐行写入瓦片行，内存仅需一行瓦片宽度，支持超大图像导出。
//! 支持 RGB（3通道）和 RGBA（4通道，多边形裁剪时使用）。
//! M5: strip 内瓦片解码使用 rayon 并行，8核机器加速 4-6×。

use crate::config::TILE_SIZE;
use crate::merger::{self, PolygonPoint};
use crate::tile::{TileBounds, bounds_to_mercator};
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::{Write, Seek, SeekFrom, BufWriter};
use std::path::{Path, PathBuf};

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
/// 内存占用: 仅 width × TILE_SIZE × channels 字节（一行瓦片）
/// 支持多边形裁剪：传入 polygons 后自动切换 RGBA 模式，多边形外像素透明
pub fn merge_and_export_streaming(
    tile_files: &HashMap<(u32, u32), PathBuf>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    compression: &str,
    polygons: Option<&[Vec<PolygonPoint>]>,
) -> Result<u64, String> {
    let cols = x_max - x_min + 1;
    let rows = y_max - y_min + 1;
    let width = cols * TILE_SIZE;
    let height = rows * TILE_SIZE;
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

    // ===== 2. 双缓冲流水线：解码/掩码 与 压缩/写盘 并行 =====
    let strip_byte_size = strip_byte_size_u64 as usize;

    // 写入线程：接收原始 strip，压缩并写入文件
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
    let compression_owned = compression.to_string();

    let writer_handle = std::thread::spawn(move || -> Result<(BufWriter<std::fs::File>, Vec<u64>, Vec<u64>), String> {
        let mut strip_offsets: Vec<u64> = Vec::with_capacity(num_strips as usize);
        let mut strip_counts: Vec<u64> = Vec::with_capacity(num_strips as usize);

        for strip_data in rx {
            let (compressed, _comp_tag) = compress_strip(&strip_data, &compression_owned)?;
            let offset = stream_pos(&mut w)?;
            w.write_all(&compressed).map_err(e2s)?;
            strip_offsets.push(offset);
            strip_counts.push(compressed.len() as u64);
        }

        Ok((w, strip_offsets, strip_counts))
    });

    for tile_y in y_min..=y_max {
        // 创建一行瓦片的 strip 缓冲区
        // RGB: 白色背景(255)，RGBA: 透明背景(0)
        let mut strip = if has_mask {
            vec![0u8; strip_byte_size]
        } else {
            vec![255u8; strip_byte_size]
        };

        let ch = channels as usize;

        // M5.1: rayon 并行解码本行所有瓦片
        let tile_xs: Vec<u32> = (x_min..=x_max).collect();
        let decoded: Vec<Option<(usize, image::RgbImage)>> = tile_xs.par_iter()
            .map(|&tile_x| {
                let file_path = tile_files.get(&(tile_x, tile_y))?;
                let bytes = std::fs::read(file_path).ok()?;
                let img = image::load_from_memory(&bytes).ok()?;
                let px = ((tile_x - x_min) * TILE_SIZE) as usize;
                Some((px, img.to_rgb8()))
            })
            .collect();

        // 串行填入 strip（顺序写内存，缓存友好）
        for item in &decoded {
            if let Some((px, rgb)) = item {
                let tile_w = rgb.width().min(TILE_SIZE) as usize;
                let tile_h = rgb.height().min(TILE_SIZE) as usize;
                let raw = rgb.as_raw();

                for row in 0..tile_h {
                    let src_start = row * rgb.width() as usize * 3;
                    for col in 0..tile_w {
                        let si = src_start + col * 3;
                        let di = row * width as usize * ch + (px + col) * ch;
                        if si + 2 < raw.len() && di + ch - 1 < strip.len() {
                            strip[di] = raw[si];
                            strip[di + 1] = raw[si + 1];
                            strip[di + 2] = raw[si + 2];
                            if has_mask {
                                strip[di + 3] = 255;
                            }
                        }
                    }
                }
            }
        }
        drop(decoded);

        // RGBA 模式：应用多边形掩码（扫描线算法）
        if has_mask && !pixel_rings.is_empty() {
            let strip_y_start = (tile_y - y_min) * TILE_SIZE;
            for local_row in 0..TILE_SIZE {
                let global_y = (strip_y_start + local_row) as i32;

                // 收集所有多边形环在该行的交点
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

                // 多边形外的像素 alpha 设为 0
                // 策略：先把整行 alpha 清零，再填充多边形内部
                let row_offset = local_row as usize * width as usize * ch;
                for x in 0..width as usize {
                    let idx = row_offset + x * ch + 3;
                    if idx < strip.len() {
                        strip[idx] = 0;
                    }
                }
                for chunk in intersections.chunks(2) {
                    if chunk.len() == 2 {
                        let x_start = (chunk[0].max(0) as usize).min(width as usize);
                        let x_end = (chunk[1].max(0) as usize).min(width as usize);
                        for x in x_start..x_end {
                            let idx = row_offset + x * ch + 3;
                            if idx < strip.len() {
                                strip[idx] = 255;
                            }
                        }
                    }
                }
            }
        }

        // 发送到写入线程（压缩+写盘与下一行解码并行）
        tx.send(strip).map_err(|e| format!("发送 strip 失败: {}", e))?;
    }
    drop(tx);

    // 等待写入线程完成，取回 writer 和元数据
    let (mut w, strip_offsets, strip_counts) = writer_handle.join()
        .map_err(|_| "写入线程异常退出".to_string())??;

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
    write_bigtiff_entry(&mut w, 273, 16, num_strips as u64, strip_offsets_offset)?;  // StripOffsets (LONG8)
    write_bigtiff_entry(&mut w, 277, 3, 1, channels as u64)?;                       // SamplesPerPixel
    write_bigtiff_entry(&mut w, 278, 4, 1, rows_per_strip as u64)?;                 // RowsPerStrip
    write_bigtiff_entry(&mut w, 279, 16, num_strips as u64, strip_counts_offset)?;  // StripByteCounts (LONG8)
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
