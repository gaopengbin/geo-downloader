//! 瓦片拼接模块

use crate::config::TILE_SIZE;
use image::{DynamicImage, RgbaImage, RgbImage};
use std::collections::HashMap;

/// 拼接瓦片为一张大图
pub fn merge_tiles(
    tile_images: &HashMap<(u32, u32), DynamicImage>,
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

            if let Some(img) = tile_images.get(&(x, y)) {
                let rgb = img.to_rgb8();
                
                // 如果尺寸不对，调整大小 (罕见情况)
                let rgb = if rgb.width() != TILE_SIZE || rgb.height() != TILE_SIZE {
                    image::imageops::resize(
                        &rgb,
                        TILE_SIZE,
                        TILE_SIZE,
                        image::imageops::FilterType::Triangle, // 用更快的滤波器
                    )
                } else {
                    rgb
                };

                // 使用 copy_from 直接复制内存，比逐像素快很多
                image::imageops::replace(&mut merged, &rgb, px as i64, py as i64);
            }
            // 空白瓦片不需要处理，已经是白色背景
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

/// 按多边形裁剪图片 (返回 RGBA，多边形外透明)
pub fn mask_image_by_polygon(
    image: &RgbImage,
    polygon: &[PolygonPoint],
    image_bounds: (f64, f64, f64, f64), // (north, south, east, west)
) -> RgbaImage {
    let (width, height) = image.dimensions();
    let (img_north, img_south, img_east, img_west) = image_bounds;

    let lat_span = img_north - img_south;
    let lng_span = img_east - img_west;

    // 将多边形转换为像素坐标
    let pixels: Vec<(i32, i32)> = polygon
        .iter()
        .map(|p| {
            let x = ((p.lng - img_west) / lng_span * width as f64) as i32;
            let y = ((img_north - p.lat) / lat_span * height as f64) as i32;
            (x, y)
        })
        .collect();

    // 直接操作原始字节，比 put_pixel 快很多
    let src_raw = image.as_raw();
    let mut dst_raw: Vec<u8> = vec![0; (width * height * 4) as usize];

    if pixels.len() < 3 {
        // 多边形点数不足，返回完整图像
        for y in 0..height {
            for x in 0..width {
                let src_idx = ((y * width + x) * 3) as usize;
                let dst_idx = ((y * width + x) * 4) as usize;
                dst_raw[dst_idx] = src_raw[src_idx];
                dst_raw[dst_idx + 1] = src_raw[src_idx + 1];
                dst_raw[dst_idx + 2] = src_raw[src_idx + 2];
                dst_raw[dst_idx + 3] = 255;
            }
        }
    } else {
        // 使用扫描线算法优化，每行只计算一次多边形交点
        for y in 0..height {
            let yi = y as i32;
            // 找到该行与多边形的所有交点
            let mut intersections: Vec<i32> = Vec::new();
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
            intersections.sort_unstable();
            
            // 填充交点之间的像素
            for chunk in intersections.chunks(2) {
                if chunk.len() == 2 {
                    let x_start = (chunk[0].max(0) as u32).min(width);
                    let x_end = (chunk[1].max(0) as u32).min(width);
                    for x in x_start..x_end {
                        let src_idx = ((y * width + x) * 3) as usize;
                        let dst_idx = ((y * width + x) * 4) as usize;
                        dst_raw[dst_idx] = src_raw[src_idx];
                        dst_raw[dst_idx + 1] = src_raw[src_idx + 1];
                        dst_raw[dst_idx + 2] = src_raw[src_idx + 2];
                        dst_raw[dst_idx + 3] = 255;
                    }
                }
            }
        }
    }

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
    let lat_per_pixel = (img_north - img_south) / height as f64;

    let left = ((tgt_west - img_west) / lng_per_pixel) as u32;
    let right = ((tgt_east - img_west) / lng_per_pixel) as u32;
    let top = ((img_north - tgt_north) / lat_per_pixel) as u32;
    let bottom = ((img_north - tgt_south) / lat_per_pixel) as u32;

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
