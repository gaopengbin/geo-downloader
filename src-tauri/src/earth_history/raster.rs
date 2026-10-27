use super::{decoder::Node, Result};
use image::{Rgba, RgbaImage};
use std::f64::consts::PI;

const WEB_R: f64 = 6_378_137.;
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    (0..3).map(|i| a[i] * b[i]).sum()
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| a[i] - b[i])
}
pub fn project(p: [f64; 3]) -> [f64; 2] {
    let lon = p[1].atan2(p[0]);
    let lat = p[2].atan2(p[0].hypot(p[1]));
    [WEB_R * lon, WEB_R * (PI / 4. + lat / 2.).tan().ln()]
}
pub fn grid_bounds(z: u8, x: u32, y: u32) -> [f64; 4] {
    let width = 2. * PI * WEB_R / (1u64 << z) as f64;
    [
        -PI * WEB_R + x as f64 * width,
        PI * WEB_R - (y + 1) as f64 * width,
        -PI * WEB_R + (x + 1) as f64 * width,
        PI * WEB_R - y as f64 * width,
    ]
}

pub fn render(nodes: &[Node], bounds: [f64; 4], width: u32, height: u32) -> Result<RgbaImage> {
    if width == 0 || height == 0 || width as u64 * height as u64 > 16_777_216 {
        return Err("EARTH_BUDGET: raster dimensions".into());
    }
    let dx = (bounds[2] - bounds[0]) / width as f64;
    let dy = (bounds[3] - bounds[1]) / height as f64;
    if dx <= 0. || dy <= 0. {
        return Err("EARTH_GEOMETRY: invalid raster extent".into());
    }
    let mut output = RgbaImage::new(width, height);
    let mut depths = vec![0.; width as usize * height as usize];
    let mut intersection_budget = 0u64;
    let rays: Vec<[f64; 3]> = (0..height)
        .flat_map(|y| {
            (0..width).map(move |x| {
                let lon = (bounds[0] + (x as f64 + 0.5) * dx) / WEB_R;
                let lat = 2. * ((bounds[3] - (y as f64 + 0.5) * dy) / WEB_R).exp().atan() - PI / 2.;
                [lat.cos() * lon.cos(), lat.cos() * lon.sin(), lat.sin()]
            })
        })
        .collect();
    for node in nodes {
        for mesh in &node.meshes {
            for tri in &mesh.triangles {
                let [a, b, c] = tri.map(|i| mesh.positions[i]);
                let projected = [project(a), project(b), project(c)];
                let px = projected.map(|p| [(p[0] - bounds[0]) / dx, (bounds[3] - p[1]) / dy]);
                let min_x = px
                    .iter()
                    .map(|p| p[0].floor())
                    .fold(f64::INFINITY, f64::min)
                    .max(0.) as u32;
                let max_x = px
                    .iter()
                    .map(|p| p[0].ceil())
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(width as f64 - 1.)
                    .max(0.) as u32;
                let min_y = px
                    .iter()
                    .map(|p| p[1].floor())
                    .fold(f64::INFINITY, f64::min)
                    .max(0.) as u32;
                let max_y = px
                    .iter()
                    .map(|p| p[1].ceil())
                    .fold(f64::NEG_INFINITY, f64::max)
                    .min(height as f64 - 1.)
                    .max(0.) as u32;
                if min_x >= width || min_y >= height || min_x > max_x || min_y > max_y {
                    continue;
                }
                intersection_budget = intersection_budget
                    .saturating_add(u64::from(max_x - min_x + 1) * u64::from(max_y - min_y + 1));
                if intersection_budget > 20_000_000 {
                    return Err("EARTH_BUDGET: raster intersection working limit reached".into());
                }
                let e1 = sub(b, a);
                let e2 = sub(c, a);
                let tvec = a.map(|v| -v);
                let q = cross(tvec, e1);
                for y in min_y..=max_y {
                    for x in min_x..=max_x {
                        let index = (y * width + x) as usize;
                        let direction = rays[index];
                        let p = cross(direction, e2);
                        let determinant = dot(e1, p);
                        if determinant.abs() < 1e-12 {
                            continue;
                        }
                        let u = dot(tvec, p) / determinant;
                        if !(-1e-8..=1. + 1e-8).contains(&u) {
                            continue;
                        }
                        let v = dot(direction, q) / determinant;
                        if v < -1e-8 || u + v > 1. + 1e-8 {
                            continue;
                        }
                        let distance = dot(e2, q) / determinant;
                        if distance <= depths[index] || distance < 6_000_000. {
                            continue;
                        }
                        let uv: [f64; 2] = std::array::from_fn(|axis| {
                            mesh.uv[tri[0]][axis] * (1. - u - v)
                                + mesh.uv[tri[1]][axis] * u
                                + mesh.uv[tri[2]][axis] * v
                        });
                        let tx = (uv[0].clamp(0., 1.) * (mesh.texture.width() - 1) as f64).round()
                            as u32;
                        let ty = (uv[1].clamp(0., 1.) * (mesh.texture.height() - 1) as f64).round()
                            as u32;
                        let pixel = mesh.texture.get_pixel(tx, ty);
                        output.put_pixel(x, y, Rgba([pixel[0], pixel[1], pixel[2], 255]));
                        depths[index] = distance;
                    }
                }
            }
        }
    }
    Ok(output)
}
