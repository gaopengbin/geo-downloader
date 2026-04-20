//! 流式光栅图像（PNG/JPEG）导出器
//! 逐行瓦片写入，内存仅需一行瓦片宽度，复用 streaming_tiff 的 strip 生成模式。
//! PNG: 使用 png crate StreamWriter 逐行写入
//! JPEG: 需全量画布，退化为 merger 路径 + 直写文件（见 exporter::export_image_to_file）

use crate::config::TILE_SIZE;
use crate::merger::{self, PolygonPoint};
use crate::tile::TileBounds;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

/// 流式 PNG 导出：strip-by-strip 逐行写入
/// 内存占用: 仅 width × TILE_SIZE × channels 字节（一行瓦片）
/// 支持多边形裁剪：传入 polygons 后自动切换 RGBA 模式
pub fn merge_and_export_streaming_png(
    tile_files: &HashMap<(u32, u32), PathBuf>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    _bounds: &TileBounds,
    save_path: &Path,
    polygons: Option<&[Vec<PolygonPoint>]>,
) -> Result<u64, String> {
    let cols = x_max - x_min + 1;
    let rows = y_max - y_min + 1;
    let width = cols * TILE_SIZE;
    let height = rows * TILE_SIZE;

    let has_mask = polygons.is_some();
    let channels: u32 = if has_mask { 4 } else { 3 };

    // 预计算多边形像素坐标环（复用 merger 的 mercator_y）
    let pixel_rings: Vec<Vec<(i32, i32)>> = if let Some(polys) = polygons {
        let lng_span = _bounds.east - _bounds.west;
        let merc_north = merger::mercator_y(_bounds.north);
        let merc_south = merger::mercator_y(_bounds.south);
        let merc_span = merc_north - merc_south;
        polys.iter()
            .map(|ring| {
                ring.iter()
                    .map(|p| {
                        let x = ((p.lng - _bounds.west) / lng_span * width as f64) as i32;
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

    // 创建 PNG 编码器
    let file = std::fs::File::create(save_path)
        .map_err(|e| format!("创建文件失败: {}", e))?;
    let w = BufWriter::new(file);

    let mut encoder = png::Encoder::new(w, width, height);
    if has_mask {
        encoder.set_color(png::ColorType::Rgba);
    } else {
        encoder.set_color(png::ColorType::Rgb);
    }
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::Default);

    let mut writer = encoder.write_header()
        .map_err(|e| format!("PNG 写入头部失败: {}", e))?;
    let mut stream_writer = writer.stream_writer()
        .map_err(|e| format!("PNG StreamWriter 创建失败: {}", e))?;

    let ch = channels as usize;

    for tile_y in y_min..=y_max {
        // 创建一行瓦片的 strip 缓冲区
        let strip_size = width as usize * TILE_SIZE as usize * ch;
        let mut strip = if has_mask {
            vec![0u8; strip_size]
        } else {
            vec![255u8; strip_size]
        };

        // rayon 并行解码本行所有瓦片
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

        // 串行填入 strip
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

                // 先清 alpha，再填充多边形内部
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

        // 写入 PNG 流（逐行或整个 strip）
        stream_writer.write_all(&strip)
            .map_err(|e| format!("PNG strip 写入失败: {}", e))?;
    }

    stream_writer.finish()
        .map_err(|e| format!("PNG 结束写入失败: {}", e))?;

    let file_size = std::fs::metadata(save_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(file_size)
}
