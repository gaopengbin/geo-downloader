//! 瓦片拼接模块

use crate::config::TILE_SIZE;
use image::{RgbaImage, RgbImage};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 瓦片字节来源（Issue #26）：网络下载落盘文件 vs 缓存命中常驻内存。
///
/// - `Path` 由 downloader 真实下载并落到 `temp_dir` 的瓦片，merger 走文件读取。
/// - `Bytes` 由 `tile_cache::Store` 命中后直接交给 merger 的字节，
///   `Arc<Vec<u8>>` 保证 `HashMap.clone()` 时只增加引用计数，
///   不复制底层数据，零拷贝。
///
/// 设计依据 issue #26：100% 缓存命中场景下，跳过 N 次 `std::fs::write`
/// 与 N 次 `std::fs::read`，把 #25 测得的 ~480ms 写盘 IO 压到 50ms 量级。
#[derive(Debug, Clone)]
pub enum TileSource {
    Path(PathBuf),
    Bytes(Arc<Vec<u8>>),
}

impl TileSource {
    /// 从 PathBuf 构造（保持下游 API 简洁）
    #[inline]
    pub fn from_path(path: PathBuf) -> Self {
        Self::Path(path)
    }

    /// 从字节构造，自动包成 Arc 以便 HashMap 共享
    #[inline]
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self::Bytes(Arc::new(bytes))
    }

    /// 借用瓦片字节：
    /// - `Path` 变体走 `std::fs::read` 返回 `Cow::Owned`
    /// - `Bytes` 变体直接返回 `Cow::Borrowed` 零拷贝引用底层 `Arc<Vec<u8>>`
    pub fn bytes(&self) -> std::io::Result<Cow<'_, [u8]>> {
        match self {
            Self::Path(p) => std::fs::read(p).map(Cow::Owned),
            Self::Bytes(b) => Ok(Cow::Borrowed(b.as_slice())),
        }
    }

    /// 将瓦片字节拷贝到目标路径（raw_tiles 目录导出场景）。
    /// 返回写入字节数。
    pub fn copy_to(&self, dst: &Path) -> std::io::Result<u64> {
        match self {
            Self::Path(p) => std::fs::copy(p, dst),
            Self::Bytes(b) => {
                std::fs::write(dst, b.as_slice())?;
                Ok(b.len() as u64)
            }
        }
    }

    /// 如果是 `Path` 变体，返回底层路径；`Bytes` 返回 `None`。
    /// 仅供调试与遗留代码兼容；新代码请用 `bytes()`。
    pub fn as_path(&self) -> Option<&Path> {
        match self {
            Self::Path(p) => Some(p.as_path()),
            Self::Bytes(_) => None,
        }
    }
}

impl From<PathBuf> for TileSource {
    fn from(path: PathBuf) -> Self {
        Self::Path(path)
    }
}

#[cfg(test)]
mod tile_source_tests {
    use super::*;
    use std::fs;

    #[test]
    fn from_path_reads_file_bytes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("a.bin");
        fs::write(&path, b"abc123").unwrap();
        let src = TileSource::from_path(path);
        let bytes = src.bytes().unwrap();
        assert_eq!(bytes.as_ref(), b"abc123");
        // Path 变体可以拿到底层路径
        assert!(src.as_path().is_some());
    }

    #[test]
    fn from_bytes_returns_borrowed_cow() {
        let src = TileSource::from_bytes(vec![1u8, 2, 3, 4, 5]);
        let bytes = src.bytes().unwrap();
        assert_eq!(bytes.as_ref(), &[1u8, 2, 3, 4, 5]);
        // Bytes 变体应返回 Borrowed Cow（零拷贝）
        assert!(matches!(bytes, std::borrow::Cow::Borrowed(_)));
        // Bytes 变体没有底层路径
        assert!(src.as_path().is_none());
    }

    #[test]
    fn clone_bytes_is_shallow_arc_clone() {
        // Issue #26: 同一段缓存命中字节给 HashMap clone 时只应增加引用计数
        let src1 = TileSource::from_bytes(vec![0u8; 1024]);
        let src2 = src1.clone();
        match (&src1, &src2) {
            (TileSource::Bytes(a), TileSource::Bytes(b)) => {
                // 应指向同一个 Arc<Vec<u8>>
                assert!(Arc::ptr_eq(a, b));
            }
            _ => panic!("unexpected variant"),
        }
    }

    #[test]
    fn copy_to_writes_path_variant_with_fs_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let src_path = tmp.path().join("src.bin");
        fs::write(&src_path, b"hello").unwrap();
        let dst_path = tmp.path().join("dst.bin");

        let src = TileSource::from_path(src_path);
        let n = src.copy_to(&dst_path).unwrap();
        assert_eq!(n, 5);
        assert_eq!(fs::read(&dst_path).unwrap(), b"hello");
    }

    #[test]
    fn copy_to_writes_bytes_variant_with_fs_write() {
        let tmp = tempfile::tempdir().unwrap();
        let dst_path = tmp.path().join("from_mem.bin");

        let src = TileSource::from_bytes(b"world".to_vec());
        let n = src.copy_to(&dst_path).unwrap();
        assert_eq!(n, 5);
        assert_eq!(fs::read(&dst_path).unwrap(), b"world");
    }

    #[test]
    fn bytes_returns_owned_cow_for_path_variant() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("p.bin");
        fs::write(&path, b"xyz").unwrap();
        let src = TileSource::from_path(path);
        let bytes = src.bytes().unwrap();
        assert!(matches!(bytes, std::borrow::Cow::Owned(_)));
    }
}

/// 纬度 → Mercator Y（归一化值，用于像素映射）
/// 公式: ln(tan(π/4 + lat_rad/2))，与 Web Mercator 瓦片一致
pub fn mercator_y(lat_deg: f64) -> f64 {
    let lat_rad = lat_deg.to_radians();
    (std::f64::consts::PI / 4.0 + lat_rad / 2.0).tan().ln()
}

/// 拼接瓦片为一张大图（从瓦片源逐个加载，省内存）
pub fn merge_tiles(
    tile_files: &HashMap<(u32, u32), TileSource>,
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

            if let Some(source) = tile_files.get(&(x, y)) {
                // 从瓦片源（Path 或 Bytes）读取并解码单个瓦片
                let bytes = match source.bytes() {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let img = match image::load_from_memory(&bytes) {
                    Ok(img) => img,
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
