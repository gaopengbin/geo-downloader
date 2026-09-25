//! Validate downloaded and reused tile payloads before offline export.
use std::io::{Cursor, Read};

pub const MAX_TILE_BYTES: usize = 16 * 1024 * 1024;

pub fn validate(bytes: &[u8], content_type: Option<&str>) -> Result<(), String> {
    let invalid =
        || "INVALID_TILE: 服务返回了无效瓦片，请检查图源或切换服务；未写入离线成果。".to_string();
    if bytes.is_empty() || bytes.len() > MAX_TILE_BYTES {
        return Err(invalid());
    }
    let mime = content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if mime.starts_with("text/") || mime.contains("json") || mime.contains("xml") {
        return Err(invalid());
    }
    if let Ok(format) = image::guess_format(bytes) {
        if mime.contains("protobuf") || mime.contains("mapbox-vector") {
            return Err(invalid());
        }
        let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        reader.decode().map_err(|_| invalid())?;
        return Ok(());
    }
    if mime.starts_with("image/") {
        return Err(invalid());
    }
    let decoded;
    let data = if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut reader = flate2::read::GzDecoder::new(bytes).take((MAX_TILE_BYTES + 1) as u64);
        let mut output = Vec::new();
        reader.read_to_end(&mut output).map_err(|_| invalid())?;
        if output.len() > MAX_TILE_BYTES {
            return Err(invalid());
        }
        decoded = output;
        decoded.as_slice()
    } else {
        bytes
    };
    if valid_mvt(data) {
        Ok(())
    } else {
        Err(invalid())
    }
}

// Check bounded protobuf framing and required MVT layer fields. This deliberately
// does not try to identify text drawn inside an otherwise valid image.
fn varint(data: &mut &[u8]) -> Option<u64> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let (&byte, rest) = data.split_first()?;
        *data = rest;
        if shift == 63 && byte > 1 {
            return None;
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Some(value);
        }
    }
    None
}

fn field<'a>(data: &mut &'a [u8]) -> Option<(u64, u64, &'a [u8])> {
    let key = varint(data)?;
    if key >> 3 == 0 {
        return None;
    }
    let (scalar, length) = match key & 7 {
        0 => (varint(data)?, 0),
        1 => (0, 8),
        2 => (0, usize::try_from(varint(data)?).ok()?),
        5 => (0, 4),
        _ => return None,
    };
    if length > data.len() {
        return None;
    }
    let (value, rest) = data.split_at(length);
    *data = rest;
    Some((key, scalar, value))
}

fn valid_mvt(mut data: &[u8]) -> bool {
    let mut layers = 0;
    while !data.is_empty() {
        let Some((key, _, mut layer)) = field(&mut data) else {
            return false;
        };
        if key != 26 {
            continue;
        }
        let (mut name, mut version) = (false, false);
        while !layer.is_empty() {
            let Some((key, scalar, value)) = field(&mut layer) else {
                return false;
            };
            if key == 10 {
                name = !value.is_empty() && std::str::from_utf8(value).is_ok();
            }
            if key == 120 {
                version = scalar == 1 || scalar == 2;
            }
        }
        if !name || !version {
            return false;
        }
        layers += 1;
    }
    layers > 0
}

pub fn valid_file(path: &std::path::Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut bytes = Vec::new();
    file.take((MAX_TILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .is_ok()
        && validate(&bytes, None).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_error_documents_and_truncated_images_but_keeps_mvt() {
        assert!(validate(b"<html>Access blocked</html>", Some("image/png")).is_err());
        assert!(validate(b"\x89PNG\r\n\x1a\n", None).is_err());
        let mvt = b"\x1a\x07\x0a\x03osm\x78\x02";
        assert!(validate(mvt, Some("application/x-protobuf")).is_ok());
        assert!(validate(mvt, Some("text/html")).is_err());
        assert!(validate(&mvt[..8], None).is_err());
        use std::io::Write;
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(mvt).unwrap();
        assert!(validate(&gzip.finish().unwrap(), None).is_ok());
        let mut png = Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        assert!(validate(png.get_ref(), Some("image/png")).is_ok());
        assert!(validate(png.get_ref(), Some("text/html")).is_err());
    }
}
