use super::{cancelled, project, wgs_to_gcj, RasterConfig, RasterStyle, Rendered, PAD, SIZE};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, PixmapPaint, Stroke, Transform};
use tokio_util::sync::CancellationToken;

struct SystemFont {
    bytes: Vec<u8>,
    index: u32,
}
static FONT: OnceLock<Option<SystemFont>> = OnceLock::new();
pub(super) fn font_state() -> Option<bool> {
    FONT.get().map(Option::is_some)
}
pub(super) fn ensure_font() -> bool {
    font().is_some()
}
fn font() -> Option<&'static SystemFont> {
    FONT.get_or_init(|| {
        let windows =
            PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:/Windows".into()))
                .join("Fonts");
        let mut candidates = vec![
            windows.join("msyhbd.ttc"),
            windows.join("msyh.ttc"),
            windows.join("simsun.ttc"),
        ];
        candidates.extend(
            [
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
                "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            ]
            .map(PathBuf::from),
        );
        for path in candidates {
            if std::fs::metadata(&path)
                .map(|m| m.len() > 128 * 1024 * 1024)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            for index in 0..ttf_parser::fonts_in_collection(&bytes).unwrap_or(1).min(8) {
                if ttf_parser::Face::parse(&bytes, index)
                    .ok()
                    .and_then(|f| f.glyph_index('地'))
                    .is_some()
                {
                    return Some(SystemFont { bytes, index });
                }
            }
        }
        None
    })
    .as_ref()
}
struct Outline(PathBuilder);
impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        self.0.move_to(x, y)
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.0.line_to(x, y)
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.0.quad_to(x1, y1, x, y)
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.0.cubic_to(x1, y1, x2, y2, x, y)
    }
    fn close(&mut self) {
        self.0.close()
    }
}
struct Glyph {
    pixmap: Pixmap,
    left: i32,
    top: i32,
}
#[derive(Default)]
struct GlyphCache {
    values: HashMap<(char, u8), Arc<Glyph>>,
    bytes: usize,
}
static GLYPHS: OnceLock<Mutex<GlyphCache>> = OnceLock::new();
fn glyph(face: &ttf_parser::Face<'_>, ch: char, size: u8) -> Option<Arc<Glyph>> {
    let key = (ch, size);
    if let Some(value) = GLYPHS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .values
        .get(&key)
    {
        return Some(value.clone());
    }
    let id = face.glyph_index(ch)?;
    let mut outline = Outline(PathBuilder::new());
    let rect = face.outline_glyph(id, &mut outline)?;
    let scale = size as f32 / face.units_per_em() as f32;
    let left = (rect.x_min as f32 * scale).floor() as i32 - 3;
    let top = (-rect.y_max as f32 * scale).floor() as i32 - 3;
    let width = (rect.x_max as f32 * scale).ceil() as i32 - left + 3;
    let height = (-rect.y_min as f32 * scale).ceil() as i32 - top + 3;
    if width <= 0 || height <= 0 || width > 128 || height > 128 {
        return None;
    }
    let path = outline.0.finish()?;
    let mut pixmap = Pixmap::new(width as u32, height as u32)?;
    let transform = Transform::from_row(scale, 0., 0., -scale, -left as f32, -top as f32);
    let mut paint = Paint::default();
    paint.set_color_rgba8(255, 255, 255, 255);
    paint.anti_alias = true;
    pixmap.stroke_path(
        &path,
        &paint,
        &Stroke {
            width: 3. / scale,
            line_join: tiny_skia::LineJoin::Round,
            ..Default::default()
        },
        transform,
        None,
    );
    paint.set_color_rgba8(23, 33, 44, 255);
    pixmap.fill_path(&path, &paint, FillRule::Winding, transform, None);
    let value = Arc::new(Glyph { pixmap, left, top });
    let mut cache = GLYPHS.get().unwrap().lock().unwrap();
    if cache.bytes >= 8 * 1024 * 1024 || cache.values.len() >= 4096 {
        cache.values.clear();
        cache.bytes = 0;
    }
    cache.bytes += value.pixmap.data().len();
    cache.values.insert(key, value.clone());
    Some(value)
}
fn pixel(value: &Value, config: &RasterConfig, z: u8, x: u32, y: u32) -> Option<(f32, f32)> {
    let coordinates = value.as_array()?;
    let (lng, lat) = (
        coordinates.first()?.as_f64()?,
        coordinates.get(1)?.as_f64()?,
    );
    let (lng, lat) = if config.gcj {
        wgs_to_gcj(lng, lat)
    } else {
        (lng, lat)
    };
    let (px, py) = project(lng, lat, z);
    Some((
        (px - x as f64 * SIZE as f64 + PAD as f64) as f32,
        (py - y as f64 * SIZE as f64 + PAD as f64) as f32,
    ))
}
fn color(style: &RasterStyle) -> (u8, u8, u8) {
    (
        u8::from_str_radix(&style.color[1..3], 16).unwrap(),
        u8::from_str_radix(&style.color[3..5], 16).unwrap(),
        u8::from_str_radix(&style.color[5..7], 16).unwrap(),
    )
}
// Clip before building paths so a long complete national feature cannot create a huge off-tile path.
fn clip(mut a: (f32, f32), mut b: (f32, f32), edge: f32) -> Option<((f32, f32), (f32, f32))> {
    fn code(p: (f32, f32), edge: f32) -> u8 {
        u8::from(p.0 < 0.)
            | u8::from(p.0 > edge) * 2
            | u8::from(p.1 < 0.) * 4
            | u8::from(p.1 > edge) * 8
    }
    for _ in 0..8 {
        let ca = code(a, edge);
        let cb = code(b, edge);
        if ca | cb == 0 {
            return Some((a, b));
        }
        if ca & cb != 0 {
            return None;
        }
        let c = if ca != 0 { ca } else { cb };
        let p = if c & 8 != 0 {
            (a.0 + (b.0 - a.0) * (edge - a.1) / (b.1 - a.1), edge)
        } else if c & 4 != 0 {
            (a.0 + (b.0 - a.0) * (-a.1) / (b.1 - a.1), 0.)
        } else if c & 2 != 0 {
            (edge, a.1 + (b.1 - a.1) * (edge - a.0) / (b.0 - a.0))
        } else {
            (0., a.1 + (b.1 - a.1) * (-a.0) / (b.0 - a.0))
        };
        if !p.0.is_finite() || !p.1.is_finite() {
            return None;
        }
        if c == ca {
            a = p
        } else {
            b = p
        }
    }
    None
}
fn geometry(
    pixmap: &mut Pixmap,
    geometry: &Value,
    style: &RasterStyle,
    config: &RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    cancel: &CancellationToken,
) -> Result<(), String> {
    let edge = pixmap.width() as f32;
    let (r, g, b) = color(style);
    let mut paint = Paint::default();
    paint.set_color_rgba8(r, g, b, 242);
    paint.anti_alias = true;
    let coordinate = |v: &Value| pixel(v, config, z, x, y);
    fn points(
        pixmap: &mut Pixmap,
        value: &Value,
        paint: &Paint<'_>,
        radius: f32,
        coordinate: &impl Fn(&Value) -> Option<(f32, f32)>,
    ) {
        if let Some((x, y)) = coordinate(value) {
            let edge = pixmap.width() as f32;
            if x >= -radius && y >= -radius && x <= edge + radius && y <= edge + radius {
                if let Some(path) = PathBuilder::from_circle(x, y, radius) {
                    pixmap.fill_path(&path, paint, FillRule::Winding, Transform::identity(), None)
                }
            }
        } else if let Some(values) = value.as_array() {
            for child in values {
                points(pixmap, child, paint, radius, coordinate)
            }
        }
    }
    fn lines(
        builder: &mut PathBuilder,
        value: &Value,
        edge: f32,
        coordinate: &impl Fn(&Value) -> Option<(f32, f32)>,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        let Some(values) = value.as_array() else {
            return Ok(());
        };
        if values.first().and_then(coordinate).is_some() {
            let mut previous = None;
            for (index, pair) in values.windows(2).enumerate() {
                if index % 256 == 0 && cancel.is_cancelled() {
                    return Err(cancelled());
                }
                if let (Some(a), Some(b)) = (coordinate(&pair[0]), coordinate(&pair[1])) {
                    if let Some((a, b)) = clip(a, b, edge) {
                        if previous != Some(a) {
                            builder.move_to(a.0, a.1)
                        }
                        builder.line_to(b.0, b.1);
                        previous = Some(b)
                    } else {
                        previous = None
                    }
                }
            }
        } else {
            for child in values {
                lines(builder, child, edge, coordinate, cancel)?
            }
        }
        Ok(())
    }
    if geometry["type"]
        .as_str()
        .is_some_and(|s| s.contains("Point"))
    {
        points(
            pixmap,
            &geometry["coordinates"],
            &paint,
            style.width as f32 + 1.,
            &coordinate,
        )
    } else {
        let mut builder = PathBuilder::new();
        lines(
            &mut builder,
            &geometry["coordinates"],
            edge,
            &coordinate,
            cancel,
        )?;
        if let Some(path) = builder.finish() {
            let dash = if matches!(style.layer, super::Layer::Railways) {
                tiny_skia::StrokeDash::new(vec![8., 3.], 0.)
            } else {
                None
            };
            pixmap.stroke_path(
                &path,
                &paint,
                &Stroke {
                    width: style.width as f32,
                    line_cap: tiny_skia::LineCap::Round,
                    line_join: tiny_skia::LineJoin::Round,
                    dash,
                    ..Default::default()
                },
                Transform::identity(),
                None,
            );
        }
    }
    Ok(())
}
fn anchor(
    value: &Value,
    config: &RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    edge: f32,
) -> Option<(f32, f32)> {
    if let Some(p) = pixel(value, config, z, x, y) {
        return (p.0 >= 0. && p.1 >= 0. && p.0 < edge && p.1 < edge).then_some(p);
    }
    value
        .as_array()?
        .iter()
        .find_map(|v| anchor(v, config, z, x, y, edge))
}
// Line anchors follow the complete feature's arc length, not a tile's first visible vertex.
// Adjacent image tiles therefore draw the same label at the same world position.
pub(super) fn line_anchors(
    value: &Value,
    config: &RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    edge: f32,
) -> Vec<(f32, f32)> {
    let Some(values) = value.as_array() else {
        return Vec::new();
    };
    if values
        .first()
        .and_then(|v| pixel(v, config, z, x, y))
        .is_none()
    {
        return values
            .iter()
            .flat_map(|v| line_anchors(v, config, z, x, y, edge))
            .collect();
    }
    let mut result = Vec::new();
    let mut distance = 0f64;
    for pair in values.windows(2) {
        let (Some(a), Some(b)) = (
            pixel(&pair[0], config, z, x, y),
            pixel(&pair[1], config, z, x, y),
        ) else {
            continue;
        };
        let length = ((b.0 as f64 - a.0 as f64).powi(2) + (b.1 as f64 - a.1 as f64).powi(2)).sqrt();
        if length < 0.001 {
            continue;
        }
        if let Some((first, last)) = clip(a, b, edge) {
            let offset = |p: (f32, f32)| {
                ((p.0 as f64 - a.0 as f64).powi(2) + (p.1 as f64 - a.1 as f64).powi(2)).sqrt()
            };
            let start = distance + offset(first);
            let end = distance + offset(last);
            let mut at = (start / 384.).ceil() * 384.;
            while at <= end + 0.0001 {
                let t = ((at - distance) / length).clamp(0., 1.) as f32;
                result.push((a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t));
                at += 384.;
            }
        }
        distance += length;
    }
    result
}
fn label(
    pixmap: &mut Pixmap,
    face: &ttf_parser::Face<'_>,
    name: &str,
    size: u8,
    point: (f32, f32),
    occupied: &mut HashSet<(i32, i32)>,
) {
    let scale = size as f32 / face.units_per_em() as f32;
    let mut chars = Vec::new();
    let mut width = 0.;
    for ch in name.chars().take(80) {
        let advance = face
            .glyph_index(ch)
            .and_then(|id| face.glyph_hor_advance(id))
            .unwrap_or(face.units_per_em()) as f32
            * scale;
        if width + advance > 240. {
            let ch = '…';
            let a = face
                .glyph_index(ch)
                .and_then(|id| face.glyph_hor_advance(id))
                .unwrap_or(face.units_per_em()) as f32
                * scale;
            chars.push((ch, a));
            width += a;
            break;
        }
        chars.push((ch, advance));
        width += advance;
    }
    let left = point.0 - width / 2.;
    let baseline = point.1 - 7.;
    let top = baseline - size as f32 - 3.;
    let mut cells = Vec::new();
    for x in ((left - 3.) / 32.).floor() as i32..=((left + width + 3.) / 32.).floor() as i32 {
        for y in (top / 20.).floor() as i32..=((baseline + 4.) / 20.).floor() as i32 {
            cells.push((x, y))
        }
    }
    if cells.iter().any(|key| occupied.contains(key)) {
        return;
    }
    occupied.extend(cells);
    let mut pen = left;
    for (ch, advance) in chars {
        if let Some(g) = glyph(face, ch, size) {
            pixmap.draw_pixmap(
                (pen + g.left as f32).round() as i32,
                (baseline + g.top as f32).round() as i32,
                g.pixmap.as_ref(),
                &PixmapPaint::default(),
                Transform::identity(),
                None,
            );
        }
        pen += advance;
    }
}
pub(super) fn render(
    features: &[(RasterStyle, Vec<Value>)],
    config: &RasterConfig,
    z: u8,
    x: u32,
    y: u32,
    cancel: &CancellationToken,
) -> Result<Rendered, String> {
    let mut pixmap = Pixmap::new(SIZE + 2 * PAD, SIZE + 2 * PAD)
        .ok_or("FOUNDATION_RASTER: allocation failed")?;
    for (style, features) in features {
        for feature in features {
            if cancel.is_cancelled() {
                return Err(cancelled());
            }
            geometry(
                &mut pixmap,
                &feature["geometry"],
                style,
                config,
                z,
                x,
                y,
                cancel,
            )?
        }
    }
    let needs_font = features.iter().any(|(s, v)| s.labels && !v.is_empty());
    let font = if needs_font { font() } else { None };
    let face = font.and_then(|font| ttf_parser::Face::parse(&font.bytes, font.index).ok());
    if let Some(face) = face.as_ref() {
        let mut occupied = HashSet::new();
        for (style, features) in features.iter().rev() {
            if !style.labels {
                continue;
            }
            let mut ordered = features.iter().collect::<Vec<_>>();
            ordered.sort_by(|a, b| {
                a["properties"]["CLASS"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["properties"]["CLASS"].as_str().unwrap_or(""))
                    .then_with(|| {
                        a["properties"]["OBJECTID"]
                            .as_i64()
                            .unwrap_or(0)
                            .cmp(&b["properties"]["OBJECTID"].as_i64().unwrap_or(0))
                    })
                    .then_with(|| {
                        a["id"]
                            .as_str()
                            .unwrap_or("")
                            .cmp(b["id"].as_str().unwrap_or(""))
                    })
            });
            for feature in ordered {
                if cancel.is_cancelled() {
                    return Err(cancelled());
                }
                let props = &feature["properties"];
                let name = props["NAME"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| props["RN"].as_str())
                    .or_else(|| props["name"].as_str())
                    .unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                if feature["geometry"]["type"]
                    .as_str()
                    .is_some_and(|kind| kind.contains("Point"))
                {
                    if let Some(point) = anchor(
                        &feature["geometry"]["coordinates"],
                        config,
                        z,
                        x,
                        y,
                        pixmap.width() as f32,
                    ) {
                        label(
                            &mut pixmap,
                            face,
                            name,
                            config.font_size,
                            point,
                            &mut occupied,
                        )
                    }
                } else {
                    for point in line_anchors(
                        &feature["geometry"]["coordinates"],
                        config,
                        z,
                        x,
                        y,
                        pixmap.width() as f32,
                    ) {
                        label(
                            &mut pixmap,
                            face,
                            name,
                            config.font_size,
                            point,
                            &mut occupied,
                        )
                    }
                }
            }
        }
    }
    if cancel.is_cancelled() {
        return Err(cancelled());
    }
    let mut cropped = Pixmap::new(SIZE, SIZE).ok_or("FOUNDATION_RASTER: allocation failed")?;
    cropped.draw_pixmap(
        -(PAD as i32),
        -(PAD as i32),
        pixmap.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        None,
    );
    let empty = cropped.pixels().iter().all(|p| p.alpha() == 0);
    Ok(Rendered {
        png: cropped
            .encode_png()
            .map_err(|_| "FOUNDATION_RASTER: PNG encoding failed")?,
        font_available: face.is_some() || !needs_font,
        empty,
    })
}
