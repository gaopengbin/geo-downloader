//! Terrarium 编码工具
//!
//! 编码格式：每个 PNG 像素的 RGB 三通道编码一个浮点高程值（米）：
//!   elevation_m = (R * 256 + G + B / 256) - 32768
//!
//! 范围：-32768.0 ～ +32767.996 m，理论精度 1/256 m (~3.9 mm)。
//! 实际数据来源 NASADEM + SRTM 等融合，PNG 压缩有轻微损失。

/// 解码单个像素 (R, G, B) → 米高程
#[inline]
pub fn decode_pixel(r: u8, g: u8, b: u8) -> f32 {
    (r as f32 * 256.0 + g as f32 + b as f32 / 256.0) - 32768.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sea_level_codes_to_zero_neighborhood() {
        // (128, 0, 0) -> 128*256 - 32768 = 0
        assert!((decode_pixel(128, 0, 0)).abs() < 1e-3);
    }

    #[test]
    fn negative_below_sea_level() {
        // (127, 255, 255) -> 32767.996 - 32768 ≈ -0.004
        let v = decode_pixel(127, 255, 255);
        assert!(v < 0.0 && v > -1.0);
    }

    #[test]
    fn high_altitude() {
        // 8848m ≈ Mount Everest
        // (160, 144, 0) → 160*256 + 144 - 32768 = 40960 + 144 - 32768 = 8336 -- 验证编码可达高山
        let v = decode_pixel(162, 144, 0);
        assert!(v > 8000.0 && v < 9000.0);
    }
}
