//! 瓦片拼接模块

use crate::config::TILE_SIZE;
use image::{RgbaImage, RgbImage};
use std::collections::HashMap;
use std::path::PathBuf;

/// 纬度 → Mercator Y（归一化值，用于像素映射）
/// 公式: ln(tan(π/4 + lat_rad/2))，与 Web Mercator 瓦片一致
pub fn mercator_y(lat_deg: f64) -> f64 {
    let lat_rad = lat_deg.to_radians();
    (std::f64::consts::PI / 4.0 + lat_rad / 2.0).tan().ln()
}

/// 拼接瓦片为一张大图（从磁盘逐个加载，省内存）
pub fn merge_tiles(
    tile_files: &HashMap<(u32, u32), PathBuf>,
    x_min: u32,
    y_min: u32,
    x_max: u32,
    y_max: u32,
) -> RgbImage {
    let cols = x_max - x_min + 1;
    let rows = y_max - y_min + 1;

    let width = cols * TILE_SIZE;
    let height = rows * TILE_SIZE;

    // 创建白色背景
    let mut merged = RgbImage::from_pixel(width, height, image::Rgb([255, 255, 255]));

    for x in x_min..=x_max {
        for y in y_min..=y_max {
            let px = (x - x_min) * TILE_SIZE;
            let py = (y - y_min) * TILE_SIZE;

            if let Some(file_path) = tile_files.get(&(x, y)) {
                // 从磁盘读取并解码单个瓦片
                let img = match std::fs::read(file_path) {
                    Ok(bytes) => match image::load_from_memory(&bytes) {
                        Ok(img) => img,
                        Err(_) => continue,
                    },
                    Err(_) => continue,
                };
                let rgb = img.to_rgb8();
                
                let rgb = if rgb.width() != TILE_SIZE || rgb.height() != TILE_SIZE {
                    image::imageops::resize(
                        &rgb,
                        TILE_SIZE,
                        TILE_SIZE,
                        image::imageops::FilterType::Triangle,
                    )
                } else {
                    rgb
                };

                image::imageops::replace(&mut merged, &rgb, px as i64, py as i64);
            }
            // img 在这里 drop，内存只保持 1 个瓦片 + 画布
        }
    }

    merged
}

/// 多边形坐标点
#[derive(Debug, Clone, Copy)]
pub struct PolygonPoint {
    pub lat: f64,
    pub lng: f64,
}

/// 按多个多边形裁剪图片 (返回 RGBA，多边形外透明)
/// 支持 MultiPolygon：多个不连续的面都会保留
/// 消费式 API：接收 RgbImage 所有权，函数内部完成后释放源数据以减少内存峰值
pub fn mask_image_by_polygons(
    image: RgbImage,
    polygons: &[Vec<PolygonPoint>],
    image_bounds: (f64, f64, f64, f64), // (north, south, east, west)
) -> RgbaImage {
    let (width, height) = image.dimensions();
    let (img_north, img_south, img_east, img_west) = image_bounds;

    let lng_span = img_east - img_west;
    // Web Mercator: Y 轴用 Mercator 投影映射（非线性），X 轴经度是线性的
    let merc_north = mercator_y(img_north);
    let merc_south = mercator_y(img_south);
    let merc_span = merc_north - merc_south;

    // 将所有多边形转换为像素坐标
    let all_pixel_rings: Vec<Vec<(i32, i32)>> = polygons
        .iter()
        .map(|ring| {
            ring.iter()
                .map(|p| {
                    let x = ((p.lng - img_west) / lng_span * width as f64) as i32;
                    let y = ((merc_north - mercator_y(p.lat)) / merc_span * height as f64) as i32;
                    (x, y)
                })
                .collect()
        })
        .filter(|ring: &Vec<(i32, i32)>| ring.len() >= 3)
        .collect();

    let src_raw = image.into_raw();
    let mut dst_raw: Vec<u8> = vec![0; (width as usize) * (height as usize) * 4];

    if all_pixel_rings.is_empty() {
        // 无有效多边形，返回完整图像
        for y in 0..height {
            for x in 0..width {
                let src_idx = (y as usize * width as usize + x as usize) * 3;
                let dst_idx = (y as usize * width as usize + x as usize) * 4;
                dst_raw[dst_idx] = src_raw[src_idx];
                dst_raw[dst_idx + 1] = src_raw[src_idx + 1];
                dst_raw[dst_idx + 2] = src_raw[src_idx + 2];
                dst_raw[dst_idx + 3] = 255;
            }
        }
    } else {
        // 扫描线算法：对每行，收集所有多边形的交点后合并填充
        for y in 0..height {
            let yi = y as i32;
            let mut intersections: Vec<i32> = Vec::new();

            // 遍历每个多边形环
            for pixels in &all_pixel_rings {
                let n = pixels.len();
                let mut j = n - 1;
                for i in 0..n {
                    let (xi, yyi) = pixels[i];
                    let (xj, yyj) = pixels[j];
                    if (yyi > yi) != (yyj > yi) {
                        let x_intersect = (xj - xi) * (yi - yyi) / (yyj - yyi) + xi;
                        intersections.push(x_intersect);
                    }
                    j = i;
                }
            }

            intersections.sort_unstable();
            
            // 填充交点之间的像素
            for chunk in intersections.chunks(2) {
                if chunk.len() == 2 {
                    let x_start = (chunk[0].max(0) as u32).min(width);
                    let x_end = (chunk[1].max(0) as u32).min(width);
                    for x in x_start..x_end {
                        let src_idx = (y as usize * width as usize + x as usize) * 3;
                        let dst_idx = (y as usize * width as usize + x as usize) * 4;
                        dst_raw[dst_idx] = src_raw[src_idx];
                        dst_raw[dst_idx + 1] = src_raw[src_idx + 1];
                        dst_raw[dst_idx + 2] = src_raw[src_idx + 2];
                        dst_raw[dst_idx + 3] = 255;
                    }
                }
            }
        }
    }

    drop(src_raw); // 尽早释放 RGB 源数据，减少峰值内存
    RgbaImage::from_raw(width, height, dst_raw).unwrap()
}

/// 按边界裁剪图片
pub fn crop_to_bounds(
    image: &RgbImage,
    image_bounds: (f64, f64, f64, f64), // (north, south, east, west)
    target_bounds: (f64, f64, f64, f64),
) -> RgbImage {
    let (width, height) = image.dimensions();
    let (img_north, img_south, img_east, img_west) = image_bounds;
    let (tgt_north, tgt_south, tgt_east, tgt_west) = target_bounds;

    let lng_per_pixel = (img_east - img_west) / width as f64;
    // Web Mercator: Y 方向用 Mercator 投影
    let merc_north = mercator_y(img_north);
    let merc_south = mercator_y(img_south);
    let merc_per_pixel = (merc_north - merc_south) / height as f64;

    let left = ((tgt_west - img_west) / lng_per_pixel) as u32;
    let right = ((tgt_east - img_west) / lng_per_pixel) as u32;
    let top = ((merc_north - mercator_y(tgt_north)) / merc_per_pixel) as u32;
    let bottom = ((merc_north - mercator_y(tgt_south)) / merc_per_pixel) as u32;

    // 限制范围
    let left = left.min(width);
    let right = right.min(width).max(left + 1);
    let top = top.min(height);
    let bottom = bottom.min(height).max(top + 1);

    let crop_width = right - left;
    let crop_height = bottom - top;

    let mut cropped = RgbImage::new(crop_width, crop_height);

    for y in 0..crop_height {
        for x in 0..crop_width {
            let pixel = image.get_pixel(left + x, top + y);
            cropped.put_pixel(x, y, *pixel);
        }
    }

    cropped
}
