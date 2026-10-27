use super::{
    wire::{self, Value},
    Result,
};
use image::RgbImage;
use std::io::Cursor;

pub struct Mesh {
    pub positions: Vec<[f64; 3]>,
    pub uv: Vec<[f64; 2]>,
    pub triangles: Vec<[usize; 3]>,
    pub texture: RgbImage,
}
pub struct Node {
    pub meshes: Vec<Mesh>,
    pub bounds: [f64; 4],
    pub copyrights: Vec<u64>,
}

pub fn decode(data: &[u8]) -> Result<Node> {
    let fields = wire::parse(data)?;
    let matrix =
        wire::doubles(wire::bytes(&fields, 1).ok_or("EARTH_PROTOCOL: missing mesh transform")?)?;
    if matrix.len() != 16 || [matrix[3], matrix[7], matrix[11], matrix[15]] != [0., 0., 0., 1.] {
        return Err("EARTH_UNSUPPORTED: non-affine mesh transform".into());
    }
    if wire::bytes(&fields, 6).is_some() || wire::bytes(&fields, 7).is_some() {
        return Err("EARTH_UNSUPPORTED: additional water/overlay mesh family".into());
    }
    let mut meshes = Vec::new();
    let mut allocated = 0usize;
    let mut bounds = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for body in wire::repeated(&fields, 2) {
        if meshes.len() >= 64 {
            return Err("EARTH_BUDGET: too many meshes".into());
        }
        let f = wire::parse(body)?;
        let xyz = wire::bytes(&f, 1).ok_or("EARTH_PROTOCOL: missing vertices")?;
        if xyz.len() % 3 != 0 || xyz.is_empty() || xyz.len() / 3 > 200_000 {
            return Err("EARTH_PROTOCOL: invalid vertex count".into());
        }
        let count = xyz.len() / 3;
        allocated += count * 40;
        if allocated > 128 * 1024 * 1024 {
            return Err("EARTH_BUDGET: node geometry exceeds working memory".into());
        }
        let mut previous = [0u8; 3];
        let mut positions = Vec::with_capacity(count);
        for i in 0..count {
            for axis in 0..3 {
                previous[axis] = previous[axis].wrapping_add(xyz[axis * count + i]);
            }
            let point = std::array::from_fn(|axis| {
                matrix[axis + 12]
                    + (0..3)
                        .map(|k| matrix[axis + k * 4] * f64::from(previous[k]))
                        .sum::<f64>()
            });
            let lon = point[1].atan2(point[0]).to_degrees();
            let lat = point[2].atan2(point[0].hypot(point[1])).to_degrees();
            let radius = point.iter().map(|v| v * v).sum::<f64>().sqrt();
            if !lon.is_finite()
                || !lat.is_finite()
                || point.iter().any(|v| !v.is_finite())
                || !radius.is_finite()
                || radius < 6_000_000.
            {
                return Err("EARTH_PROTOCOL: invalid globe coordinates".into());
            }
            bounds[0] = bounds[0].min(lon);
            bounds[1] = bounds[1].min(lat);
            bounds[2] = bounds[2].max(lon);
            bounds[3] = bounds[3].max(lat);
            positions.push(point);
        }
        let packed_uv =
            wire::bytes(&f, 7).ok_or("EARTH_UNSUPPORTED: no supported texture coordinates")?;
        if packed_uv.len() != 4 + count * 4 {
            return Err("EARTH_PROTOCOL: invalid UV planes".into());
        }
        let modulus = [
            u16::from_le_bytes(packed_uv[..2].try_into().unwrap()) as u32 + 1,
            u16::from_le_bytes(packed_uv[2..4].try_into().unwrap()) as u32 + 1,
        ];
        let transform = wire::floats(
            wire::bytes(&f, 10).ok_or("EARTH_UNSUPPORTED: no explicit UV transform")?,
        )?;
        if transform.len() != 4 {
            return Err("EARTH_UNSUPPORTED: UV transform variant".into());
        }
        let mut state = [0u32; 2];
        let mut uv = Vec::with_capacity(count);
        for i in 0..count {
            for axis in 0..2 {
                state[axis] = (state[axis]
                    + u32::from(packed_uv[4 + axis * count + i])
                    + (u32::from(packed_uv[4 + (axis + 2) * count + i]) << 8))
                    % modulus[axis];
            }
            // Texture bytes are top-down; invert the original renderer's final V flip here.
            uv.push(std::array::from_fn(|axis| {
                f64::from(transform[axis + 2] * (transform[axis] + state[axis] as f32))
            }));
        }
        if uv.iter().flatten().any(|v| !v.is_finite()) {
            return Err("EARTH_PROTOCOL: invalid texture transform".into());
        }
        let packed_indices = wire::bytes(&f, 3).ok_or("EARTH_PROTOCOL: missing indices")?;
        let mut at = 0;
        let length = usize::try_from(wire::varint(packed_indices, &mut at)?)
            .map_err(|_| "EARTH_PROTOCOL: index count")?;
        if length > 2_000_000 {
            return Err("EARTH_BUDGET: index count".into());
        }
        allocated += length * 32;
        if allocated > 128 * 1024 * 1024 {
            return Err("EARTH_BUDGET: node index memory".into());
        }
        let mut strip = Vec::with_capacity(length);
        let mut high = 0u64;
        for _ in 0..length {
            let code = wire::varint(packed_indices, &mut at)?;
            let index = high
                .checked_sub(code)
                .filter(|&n| n < count as u64)
                .ok_or("EARTH_PROTOCOL: vertex index out of bounds")?;
            strip.push(index as usize);
            if code == 0 {
                high += 1;
            }
        }
        if at != packed_indices.len() {
            return Err("EARTH_PROTOCOL: trailing index bytes".into());
        }
        let mut triangles = Vec::new();
        for i in 2..strip.len() {
            let [a, b, c] = [strip[i - 2], strip[i - 1], strip[i]];
            if a != b && b != c && a != c {
                triangles.push(if i % 2 == 0 { [a, b, c] } else { [a, c, b] });
            }
        }
        let textures: Vec<_> = wire::repeated(&f, 6).collect();
        if textures.len() != 1 {
            return Err("EARTH_UNSUPPORTED: multiple or missing textures".into());
        }
        let texture_fields = wire::parse(textures[0])?;
        if wire::int(&texture_fields, 2) != Some(1) {
            return Err(
                "EARTH_UNSUPPORTED: only the verified JPEG texture variant is supported".into(),
            );
        }
        let bodies: Vec<_> = wire::repeated(&texture_fields, 1).collect();
        if bodies.len() != 1 {
            return Err("EARTH_UNSUPPORTED: segmented texture".into());
        }
        let format =
            image::guess_format(bodies[0]).map_err(|_| "EARTH_PROTOCOL: invalid texture")?;
        if format != image::ImageFormat::Jpeg {
            return Err("EARTH_PROTOCOL: texture format mismatch".into());
        }
        let dimensions = image::ImageReader::with_format(Cursor::new(bodies[0]), format)
            .into_dimensions()
            .map_err(|_| "EARTH_PROTOCOL: texture header")?;
        if dimensions.0 == 0 || dimensions.1 == 0 || dimensions.0 > 4096 || dimensions.1 > 4096 {
            return Err("EARTH_BUDGET: texture dimensions".into());
        }
        allocated += dimensions.0 as usize * dimensions.1 as usize * 3;
        if allocated > 128 * 1024 * 1024 {
            return Err("EARTH_BUDGET: node texture memory".into());
        }
        let mut reader = image::ImageReader::with_format(Cursor::new(bodies[0]), format);
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let texture = reader
            .decode()
            .map_err(|_| "EARTH_PROTOCOL: texture decoding failed")?
            .to_rgb8();
        if u64::from(texture.width()) != wire::int(&texture_fields, 3).unwrap_or(256)
            || u64::from(texture.height()) != wire::int(&texture_fields, 4).unwrap_or(256)
        {
            return Err("EARTH_PROTOCOL: texture dimensions disagree".into());
        }
        meshes.push(Mesh {
            positions,
            uv,
            triangles,
            texture,
        });
    }
    if meshes.is_empty() {
        return Err("EARTH_NO_DATA: packet contains no supported mesh".into());
    }
    if let Some(box_bytes) = wire::bytes(&fields, 5) {
        let b = wire::doubles(box_bytes)?;
        // Field 5 is the nominal geographic cell. Quantized globe vertices can
        // extend a few grid steps beyond it, especially in coarse global nodes.
        // Derive angular slack from the affine grid instead of a fixed fine-LOD
        // threshold; retain the strict floor for sub-meter imagery.
        let grid_step = (0..3)
            .map(|k| (0..3).map(|axis| matrix[axis + k * 4].powi(2)).sum::<f64>().sqrt())
            .fold(0., f64::max);
        let latitude = bounds[1].abs().max(bounds[3].abs()).min(85.);
        let tolerance = (3. * grid_step / 6_000_000.).to_degrees()
            / latitude.to_radians().cos();
        let tolerance = tolerance.max(0.00005);
        if b.len() == 6
            && ((b[0] - bounds[0]).abs() > tolerance
                || (b[1] - bounds[1]).abs() > tolerance
                || (b[3] - bounds[2]).abs() > tolerance
                || (b[4] - bounds[3]).abs() > tolerance)
        {
            return Err(
                "EARTH_GEOMETRY: decoded coordinates disagree with packet geographic bounds".into(),
            );
        }
    }
    let copyrights = fields
        .iter()
        .filter_map(|f| match f.value {
            Value::Int(v) if f.number == 3 => Some(v),
            _ => None,
        })
        .collect();
    Ok(Node {
        meshes,
        bounds,
        copyrights,
    })
}
