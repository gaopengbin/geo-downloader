//! 图片导出模块

use crate::tile::TileBounds;
use image::{DynamicImage, ImageFormat, RgbImage, RgbaImage};
use std::io::Cursor;

/// 导出格式
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ExportFormat {
    GeoTiff,
    Png,
    Jpeg,
}

impl ExportFormat {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "geotiff" | "tiff" | "tif" => ExportFormat::GeoTiff,
            "png" => ExportFormat::Png,
            "jpeg" | "jpg" => ExportFormat::Jpeg,
            _ => ExportFormat::Png,
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::GeoTiff => ".tif",
            ExportFormat::Png => ".png",
            ExportFormat::Jpeg => ".jpg",
        }
    }

    pub fn content_type(&self) -> &'static str {
        match self {
            ExportFormat::GeoTiff => "image/tiff",
            ExportFormat::Png => "image/png",
            ExportFormat::Jpeg => "image/jpeg",
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

/// 导出 RGBA 图片为 PNG 字节
pub fn export_rgba_png_bytes(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
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

/// 写入 GeoTIFF 标签的辅助宏
macro_rules! write_geotiff_tags {
    ($encoder:expr, $bounds:expr, $width:expr, $height:expr) => {
        if let Some(b) = $bounds {
            use tiff::tags::Tag;
            
            let x_res = (b.east - b.west) / $width as f64;
            let y_res = (b.north - b.south) / $height as f64;
            
            let pixel_scale: [f64; 3] = [x_res, y_res, 0.0];
            let tiepoint: [f64; 6] = [0.0, 0.0, 0.0, b.west, b.north, 0.0];
            let geo_keys: [u16; 24] = [
                1, 1, 0, 5,
                1024, 0, 1, 2,
                1025, 0, 1, 1,
                2048, 0, 1, 4326,
                2054, 0, 1, 9102,
                2049, 34737, 6, 0,
            ];
            let geo_ascii = "WGS 84|";
            
            $encoder.encoder().write_tag(Tag::Unknown(33550), &pixel_scale[..]).map_err(|e| e.to_string())?;
            $encoder.encoder().write_tag(Tag::Unknown(33922), &tiepoint[..]).map_err(|e| e.to_string())?;
            $encoder.encoder().write_tag(Tag::Unknown(34735), &geo_keys[..]).map_err(|e| e.to_string())?;
            $encoder.encoder().write_tag(Tag::Unknown(34737), geo_ascii).map_err(|e| e.to_string())?;
        }
    };
}

/// 导出 RGB 图片为 GeoTIFF 字节 (带地理坐标信息)
pub fn export_tiff_bytes(image: &RgbImage, bounds: Option<&TileBounds>, compress: bool) -> Result<Vec<u8>, String> {
    use tiff::encoder::{TiffEncoder, colortype::RGB8, compression::{Lzw, Uncompressed}};
    
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    
    let mut encoder = TiffEncoder::new(&mut buffer)
        .map_err(|e| format!("TIFF 编码器创建失败: {}", e))?;
    
    if compress {
        let mut img_encoder = encoder
            .new_image_with_compression::<RGB8, _>(width, height, Lzw::default())
            .map_err(|e| format!("TIFF 导出失败: {}", e))?;
        write_geotiff_tags!(img_encoder, bounds, width, height);
        img_encoder.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
    } else {
        let mut img_encoder = encoder
            .new_image_with_compression::<RGB8, _>(width, height, Uncompressed::default())
            .map_err(|e| format!("TIFF 导出失败: {}", e))?;
        write_geotiff_tags!(img_encoder, bounds, width, height);
        img_encoder.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
    }
    
    Ok(buffer.into_inner())
}

/// 导出 RGBA 图片为 GeoTIFF 字节 (带地理坐标信息)
pub fn export_rgba_tiff_bytes(image: &RgbaImage, bounds: Option<&TileBounds>, compress: bool) -> Result<Vec<u8>, String> {
    use tiff::encoder::{TiffEncoder, colortype::RGBA8, compression::{Lzw, Uncompressed}};
    
    let (width, height) = image.dimensions();
    let mut buffer = Cursor::new(Vec::new());
    
    let mut encoder = TiffEncoder::new(&mut buffer)
        .map_err(|e| format!("TIFF 编码器创建失败: {}", e))?;
    
    if compress {
        let mut img_encoder = encoder
            .new_image_with_compression::<RGBA8, _>(width, height, Lzw::default())
            .map_err(|e| format!("TIFF 导出失败: {}", e))?;
        write_geotiff_tags!(img_encoder, bounds, width, height);
        img_encoder.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
    } else {
        let mut img_encoder = encoder
            .new_image_with_compression::<RGBA8, _>(width, height, Uncompressed::default())
            .map_err(|e| format!("TIFF 导出失败: {}", e))?;
        write_geotiff_tags!(img_encoder, bounds, width, height);
        img_encoder.write_data(image.as_raw()).map_err(|e| format!("TIFF 导出失败: {}", e))?;
    }
    
    Ok(buffer.into_inner())
}

/// 根据格式导出 RGB 图片
pub fn export_image(
    image: &RgbImage,
    format: ExportFormat,
    bounds: Option<&TileBounds>,
    compress: bool,
) -> Result<Vec<u8>, String> {
    match format {
        ExportFormat::Png => export_png_bytes(image),
        ExportFormat::Jpeg => export_jpeg_bytes(image, 90),
        ExportFormat::GeoTiff => export_tiff_bytes(image, bounds, compress),
    }
}

/// 根据格式导出 RGBA 图片 (带透明通道)
pub fn export_rgba_image(
    image: &RgbaImage,
    format: ExportFormat,
    bounds: Option<&TileBounds>,
    compress: bool,
) -> Result<Vec<u8>, String> {
    match format {
        ExportFormat::Png => export_rgba_png_bytes(image),
        ExportFormat::Jpeg => {
            let rgb = DynamicImage::ImageRgba8(image.clone()).to_rgb8();
            export_jpeg_bytes(&rgb, 90)
        }
        ExportFormat::GeoTiff => export_rgba_tiff_bytes(image, bounds, compress),
    }
}

/// 获取文件扩展名
pub fn get_file_extension(format: &str) -> &'static str {
    ExportFormat::from_str(format).extension()
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
