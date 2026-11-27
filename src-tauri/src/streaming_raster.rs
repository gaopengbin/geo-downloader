//! 流式光栅图像（PNG/JPEG）导出器
//! 逐行瓦片写入，内存仅需一行瓦片宽度，复用 streaming_tiff 的 strip 生成模式。
//! PNG: 使用 png crate StreamWriter 逐行写入
//! JPEG: 需全量画布，退化为 merger 路径 + 直写文件（见 exporter::export_image_to_file）

use crate::config::TILE_SIZE;
use crate::merger::{PolygonPoint, TileSource};
use crate::tile::TileBounds;
use rayon::prelude::*;
use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::Path;

/// 流式 PNG 导出：strip-by-strip 逐行写入
/// 内存占用: 仅 width × TILE_SIZE × channels 字节（一行瓦片）
/// 支持多边形裁剪：传入 polygons 后自动切换 RGBA 模式
pub fn merge_and_export_streaming_png(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    polygons: Option<&[Vec<PolygonPoint>]>,
) -> Result<u64, String> {
    merge_and_export_streaming_png_cancellable(tile_files, x_min, y_min, x_max, y_max, bounds, save_path, polygons, None)
}

pub fn merge_and_export_streaming_png_cancellable(
    tile_files: &HashMap<(u32, u32), TileSource>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
    bounds: &TileBounds,
    save_path: &Path,
    polygons: Option<&[Vec<PolygonPoint>]>,
    cancel: Option<&tokio_util::sync::CancellationToken>,
) -> Result<u64, String> {
    let (_cols, _rows, width, height) = crate::streaming_tiff::grid_dims(x_min, y_min, x_max, y_max)?;

    let has_mask = polygons.is_some();
    let channels: u32 = if has_mask { 4 } else { 3 };

    let pixel_rings = crate::streaming_tiff::projected_rings(bounds, width, height, polygons);
    let (file, staged) = crate::streaming_tiff::staged_raster(save_path)?;
    let mut output = BufWriter::new(file);
    let mut encoder = png::Encoder::new(&mut output, width, height);
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
        crate::streaming_tiff::check_cancelled(cancel)?;
        // 创建一行瓦片的 strip 缓冲区
        let strip_size = width as usize * TILE_SIZE as usize * ch;
        let mut strip = if has_mask {
            vec![0u8; strip_size]
        } else {
            vec![255u8; strip_size]
        };

        // rayon 并行解码本行所有瓦片
        let tile_xs: Vec<u32> = (x_min..=x_max).collect();
        let decoded: Vec<Option<(usize, image::RgbaImage)>> = tile_xs.par_iter()
            .map(|&tile_x| {
                let Some(source) = tile_files.get(&(tile_x, tile_y)) else { return Ok(None); };
                let px = ((tile_x - x_min) * TILE_SIZE) as usize;
                Ok(Some((px, source.decode_work_tile(tile_x, tile_y)?.into_rgba8())))
            })
            .collect::<Result<_, String>>()?;

        // 串行填入 strip
        for item in &decoded {
            if let Some((px, rgb)) = item {
                let tile_w = rgb.width().min(TILE_SIZE) as usize;
                let tile_h = rgb.height().min(TILE_SIZE) as usize;
                let raw = rgb.as_raw();

                for row in 0..tile_h {
                    let src_start = row * rgb.width() as usize * 4;
                    for col in 0..tile_w {
                        let si = src_start + col * 4;
                        let di = row * width as usize * ch + (px + col) * ch;
                        if si + 2 < raw.len() && di + ch - 1 < strip.len() {
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

        // RGBA 模式：应用多边形掩码（扫描线算法）
        if has_mask && !pixel_rings.is_empty() {
            let strip_y_start = (tile_y - y_min) * TILE_SIZE;
            for local_row in 0..TILE_SIZE {
                let global_y = (strip_y_start + local_row) as i32;

                let width = width as usize;
                let start = local_row as usize * width * ch;
                let row = &mut strip[start..start + width * ch];
                let mut cursor = 0;
                for (left, right) in crate::streaming_tiff::scanline_spans(&pixel_rings, global_y) {
                    let left = (left.max(0) as usize).min(width) * ch;
                    let right = (right.max(0) as usize).min(width) * ch;
                    row[cursor..left].fill(0);
                    cursor = right;
                }
                row[cursor..].fill(0);
            }
        }

        // 写入 PNG 流（逐行或整个 strip）
        stream_writer.write_all(&strip)
            .map_err(|e| format!("PNG strip 写入失败: {}", e))?;
    }

    stream_writer.finish()
        .map_err(|e| format!("PNG 结束写入失败: {}", e))?;

    writer.finish().map_err(|e| format!("PNG 结束写入失败: {e}"))?;
    output.flush().and_then(|_| output.get_ref().sync_all()).map_err(|e| e.to_string())?;
    let file_size = output.get_ref().metadata().map_err(|e| e.to_string())?.len();
    drop(output);
    crate::streaming_tiff::check_cancelled(cancel)?;
    staged.persist(save_path)?;
    Ok(file_size)
}
