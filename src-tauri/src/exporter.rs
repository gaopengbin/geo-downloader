//! 图片导出模块

use crate::tile::TileBounds;
use image::{DynamicImage, ImageFormat, RgbImage, RgbaImage};
use std::io::{Cursor, Write};

/// 导出格式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportFormat {
    GeoTiff,
    Png,
    Jpeg,
    Mbtiles,
    Gpkg,
    /// 原始瓦片目录（不做任何拼接 / 解码，按 {z}/{x}/{y}.<ext> 写盘）
    Tiles,
    /// 矢量瓦片：与 Tiles 类似但扩展名固定 .pbf，并与 mbtiles/gpkg 配合时把 format 元信息写为 "pbf"
    Pbf,
}

impl ExportFormat {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "geotiff" | "tiff" | "tif" => ExportFormat::GeoTiff,
            "png" => ExportFormat::Png,
            "jpeg" | "jpg" => ExportFormat::Jpeg,
            "mbtiles" => ExportFormat::Mbtiles,
            "gpkg" | "geopackage" => ExportFormat::Gpkg,
            "tiles" | "raw" => ExportFormat::Tiles,
            "pbf" | "mvt" => ExportFormat::Pbf,
            _ => ExportFormat::Png,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::GeoTiff => ".tif",
            ExportFormat::Png => ".png",
            ExportFormat::Jpeg => ".jpg",
            ExportFormat::Mbtiles => ".mbtiles",
            ExportFormat::Gpkg => ".gpkg",
            ExportFormat::Tiles => "",
            ExportFormat::Pbf => ".pbf",
        }
    }

    pub fn content_type(&self) -> &'static str {
        match self {
            ExportFormat::GeoTiff => "image/tiff",
            ExportFormat::Png => "image/png",
            ExportFormat::Jpeg => "image/jpeg",
            ExportFormat::Mbtiles => "application/vnd.mapbox-vector-tile",
            ExportFormat::Gpkg => "application/geopackage+sqlite3",
            ExportFormat::Tiles => "application/octet-stream",
            ExportFormat::Pbf => "application/x-protobuf",
        }
    }
}

/// 导出 RGB 图片为 PNG 字节
pub fn export_png_bytes(image: &RgbImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| format!("PNG 导出失败: {}", e))?;
    Ok(buffer.into_inner())
}

/// 导出 RGBA 图片为 PNG 字节（消费式，无 clone）
pub fn export_rgba_png_bytes(image: RgbaImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|e| format!("PNG 导出失败: {}", e))?;
    Ok(buffer.into_inner())
}

/// 导出 RGB 图片为 JPEG 字节
pub fn export_jpeg_bytes(image: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, quality);
    encoder
        .encode_image(image)
        .map_err(|e| format!("JPEG 导出失败: {}", e))?;
    
    Ok(buffer.into_inner())
}

/// 写入 GeoTIFF 标签的辅助宏——使用 EPSG:3857 (Web Mercator) 坐标
macro_rules! write_geotiff_tags {
    ($encoder:expr, $bounds:expr, $width:expr, $height:expr) => {
        if let Some(b) = $bounds {
            use tiff::tags::Tag;
            use crate::tile::bounds_to_mercator;
            
            let (west_m, south_m, east_m, north_m) = bounds_to_mercator(b);
            let x_res = (east_m - west_m) / $width as f64;
            let y_res = (north_m - south_m) / $height as f64;
            
            let pixel_scale: [f64; 3] = [x_res, y_res, 0.0];
            let tiepoint: [f64; 6] = [0.0, 0.0, 0.0, west_m, north_m, 0.0];
            let geo_keys: [u16; 16] = [
                1, 1, 0, 3,
                1024, 0, 1, 1,       // GTModelTypeGeoKey = ModelTypeProjected
                1025, 0, 1, 1,       // GTRasterTypeGeoKey = RasterPixelIsArea
                3072, 0, 1, 3857,    // ProjectedCSTypeGeoKey = EPSG:3857
            ];
            
            $encoder.encoder().write_tag(Tag::Unknown(33550), &pixel_scale[..]).map_err(|e| e.to_string())?;
            $encoder.encoder().write_tag(Tag::Unknown(33922), &tiepoint[..]).map_err(|e| e.to_string())?;
            $encoder.encoder().write_tag(Tag::Unknown(34735), &geo_keys[..]).map_err(|e| e.to_string())?;
        }
    };
}

/// 判断是否需要 BigTIFF（图像数据 > 4GB 时使用）
fn need_bigtiff(width: u32, height: u32, channels: u32) -> bool {
    (width as u64) * (height as u64) * (channels as u64) > 3_800_000_000
}

/// 导出 RGB 图片为 GeoTIFF 字节 (带地理坐标信息，超大图像自动使用 BigTIFF)
pub fn export_tiff_bytes(image: &RgbImage, bounds: Option<&TileBounds>, compression: &str) -> Result<Vec<u8>, String> {
    use tiff::encoder::{TiffEncoder, colortype::RGB8, compression::{Lzw, Deflate, Uncompressed}};
    
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    let big = need_bigtiff(width, height, 3);
    
    macro_rules! encode_rgb {
        ($encoder:expr) => {
            match compression {
                "lzw" => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGB8, _>(width, height, Lzw::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
                "deflate" => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGB8, _>(width, height, Deflate::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
                _ => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGB8, _>(width, height, Uncompressed::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
            }
        };
    }
    
    if big {
        let mut encoder = TiffEncoder::new_big(&mut buffer)
            .map_err(|e| format!("BigTIFF 编码器创建失败: {}", e))?;
        encode_rgb!(encoder);
    } else {
        let mut encoder = TiffEncoder::new(&mut buffer)
            .map_err(|e| format!("TIFF 编码器创建失败: {}", e))?;
        encode_rgb!(encoder);
    }
    
    Ok(buffer.into_inner())
}

/// 导出 RGBA 图片为 GeoTIFF 字节 (带地理坐标信息，超大图像自动使用 BigTIFF)
pub fn export_rgba_tiff_bytes(image: &RgbaImage, bounds: Option<&TileBounds>, compression: &str) -> Result<Vec<u8>, String> {
    use tiff::encoder::{TiffEncoder, colortype::RGBA8, compression::{Lzw, Deflate, Uncompressed}};
    
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    let big = need_bigtiff(width, height, 4);
    
    macro_rules! encode_rgba {
        ($encoder:expr) => {
            match compression {
                "lzw" => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGBA8, _>(width, height, Lzw::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
                "deflate" => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGBA8, _>(width, height, Deflate::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
                _ => {
                    let mut img = $encoder
                        .new_image_with_compression::<RGBA8, _>(width, height, Uncompressed::default())
                        .map_err(|e| format!("TIFF 导出失败: {}", e))?;
                    write_geotiff_tags!(img, bounds, width, height);
                    img.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
                }
            }
        };
    }
    
    if big {
        let mut encoder = TiffEncoder::new_big(&mut buffer)
            .map_err(|e| format!("BigTIFF 编码器创建失败: {}", e))?;
        encode_rgba!(encoder);
    } else {
        let mut encoder = TiffEncoder::new(&mut buffer)
            .map_err(|e| format!("TIFF 编码器创建失败: {}", e))?;
        encode_rgba!(encoder);
    }
    
    Ok(buffer.into_inner())
}

/// 根据格式导出 RGB 图片
pub fn export_image(
    image: &RgbImage,
    format: ExportFormat,
    bounds: Option<&TileBounds>,
    compression: &str,
) -> Result<Vec<u8>, String> {
    match format {
        ExportFormat::Png => export_png_bytes(image),
        ExportFormat::Jpeg => export_jpeg_bytes(image, 90),
        ExportFormat::GeoTiff => export_tiff_bytes(image, bounds, compression),
        ExportFormat::Mbtiles | ExportFormat::Gpkg | ExportFormat::Tiles | ExportFormat::Pbf => {
            Err("该格式不走 RGB 拼接路径".to_string())
        }
    }
}

/// 根据格式导出 RGBA 图片 (带透明通道，消费式)
pub fn export_rgba_image(
    image: RgbaImage,
    format: ExportFormat,
    bounds: Option<&TileBounds>,
    compression: &str,
) -> Result<Vec<u8>, String> {
    match format {
        ExportFormat::Png => export_rgba_png_bytes(image),
        ExportFormat::Jpeg => {
            let rgb = DynamicImage::ImageRgba8(image).to_rgb8();
            export_jpeg_bytes(&rgb, 90)
        }
        ExportFormat::GeoTiff => export_rgba_tiff_bytes(&image, bounds, compression),
        ExportFormat::Mbtiles | ExportFormat::Gpkg | ExportFormat::Tiles | ExportFormat::Pbf => {
            Err("该格式不走 RGBA 拼接路径".to_string())
        }
    }
}

/// 获取文件扩展名
pub fn get_file_extension(format: &str) -> &'static str {
    ExportFormat::from_str(format).extension()
}

/// 直接将 RGB 图片编码写入文件（避免 Vec<u8> 中间缓冲）
pub fn export_image_to_file(
    image: RgbImage,
    format: ExportFormat,
    path: &std::path::Path,
    bounds: Option<&TileBounds>,
    compression: &str,
) -> Result<u64, String> {
    use std::io::BufWriter;
    match format {
        ExportFormat::Png => {
            let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut w = BufWriter::new(file);
            DynamicImage::ImageRgb8(image)
                .write_to(&mut w, ImageFormat::Png)
                .map_err(|e| format!("PNG 导出失败: {}", e))?;
            w.flush().map_err(|e| format!("刷新缓冲失败: {}", e))?;
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(size)
        }
        ExportFormat::Jpeg => {
            let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut w = BufWriter::new(file);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 90);
            encoder.encode_image(&image).map_err(|e| format!("JPEG 导出失败: {}", e))?;
            drop(image);
            w.flush().map_err(|e| format!("刷新缓冲失败: {}", e))?;
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(size)
        }
        ExportFormat::GeoTiff => {
            let bytes = export_tiff_bytes(&image, bounds, compression)?;
            drop(image);
            let size = bytes.len() as u64;
            std::fs::write(path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(size)
        }
        ExportFormat::Mbtiles | ExportFormat::Gpkg | ExportFormat::Tiles | ExportFormat::Pbf => {
            Err("该格式不走 RGB 拼接路径".to_string())
        }
    }
}

/// 直接将 RGBA 图片编码写入文件（避免 Vec<u8> 中间缓冲，消费式）
pub fn export_rgba_image_to_file(
    image: RgbaImage,
    format: ExportFormat,
    path: &std::path::Path,
    bounds: Option<&TileBounds>,
    compression: &str,
) -> Result<u64, String> {
    use std::io::BufWriter;
    match format {
        ExportFormat::Png => {
            let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut w = BufWriter::new(file);
            let dyn_img = DynamicImage::ImageRgba8(image);
            dyn_img.write_to(&mut w, ImageFormat::Png)
                .map_err(|e| format!("PNG 导出失败: {}", e))?;
            w.flush().map_err(|e| format!("刷新缓冲失败: {}", e))?;
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(size)
        }
        ExportFormat::Jpeg => {
            let rgb = DynamicImage::ImageRgba8(image).to_rgb8();
            let file = std::fs::File::create(path).map_err(|e| format!("创建文件失败: {}", e))?;
            let mut w = BufWriter::new(file);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut w, 90);
            encoder.encode_image(&rgb).map_err(|e| format!("JPEG 导出失败: {}", e))?;
            drop(rgb);
            w.flush().map_err(|e| format!("刷新缓冲失败: {}", e))?;
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            Ok(size)
        }
        ExportFormat::GeoTiff => {
            let bytes = export_rgba_tiff_bytes(&image, bounds, compression)?;
            drop(image);
            let size = bytes.len() as u64;
            std::fs::write(path, &bytes).map_err(|e| format!("写入文件失败: {}", e))?;
            Ok(size)
        }
        ExportFormat::Mbtiles | ExportFormat::Gpkg | ExportFormat::Tiles | ExportFormat::Pbf => {
            Err("该格式不走 RGBA 拼接路径".to_string())
        }
    }
}

#[cfg(feature = "geotiff")]
mod geotiff {
    //! GeoTIFF 支持 (需要 GDAL)
    //! 使用 cargo build --features geotiff 启用
    
    use super::*;
    use gdal::raster::RasterCreationOption;
    use gdal::DriverManager;
    
    /// 导出带地理坐标的 GeoTIFF
    pub fn export_geotiff_bytes(
        image: &RgbImage,
        bounds: &TileBounds,
    ) -> Result<Vec<u8>, String> {
        // TODO: 实现完整的 GeoTIFF 导出
        // 需要使用 GDAL 创建内存中的 GeoTIFF
        unimplemented!("GeoTIFF export requires GDAL")
    }
}
