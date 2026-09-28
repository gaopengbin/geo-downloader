//! Pixel-center raster masks from a named GeoJSON polygon layer.
//!
//! Rings within each polygon use even-odd filling; separate polygons and
//! features are unioned. An active-edge scanline avoids testing every pixel
//! against every boundary vertex. Coordinates are WGS84 and the raster grid is
//! Web Mercator, matching GeoD's tile exports.

use crate::tile::TileBounds;
use image::{RgbImage, RgbaImage};
use serde_json::Value;

const MERCATOR_MAX_LAT: f64 = 85.05112878;
const MAX_COORDINATES: usize = 3_000_000;
const MAX_POLYGONS: usize = 100_000;
const MAX_SCANLINE_INTERSECTIONS: usize = 50_000_000;

fn invalid(message: impl std::fmt::Display) -> String {
    format!("CLIP_INVALID: {message}")
}

fn mercator_y(latitude: f64) -> f64 {
    latitude.to_radians().tan().asinh()
}

#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
    longitude: f64,
    mercator: f64,
}

#[derive(Clone, Copy)]
struct Edge {
    start: u32,
    end: u32,
    polygon: usize,
    low: Point,
    high: Point,
}

struct Grid {
    width: u32,
    height: u32,
    west: f64,
    longitude_span: f64,
    north_mercator: f64,
    mercator_span: f64,
}

impl Grid {
    fn new(width: u32, height: u32, bounds: &TileBounds) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err(invalid("raster dimensions must be positive"));
        }
        if [bounds.west, bounds.south, bounds.east, bounds.north]
            .iter()
            .any(|value| !value.is_finite())
            || bounds.west < -180.0
            || bounds.east > 180.0
            || bounds.west >= bounds.east
            || bounds.south < -MERCATOR_MAX_LAT
            || bounds.north > MERCATOR_MAX_LAT
            || bounds.south >= bounds.north
        {
            return Err(invalid(
                "raster bounds must be ordered WGS84 bounds within Web Mercator limits",
            ));
        }
        let north_mercator = mercator_y(bounds.north);
        let mercator_span = north_mercator - mercator_y(bounds.south);
        if !mercator_span.is_finite() || mercator_span <= 0.0 {
            return Err(invalid("raster latitude span is too small to project"));
        }
        Ok(Self {
            width,
            height,
            west: bounds.west,
            longitude_span: bounds.east - bounds.west,
            north_mercator,
            mercator_span,
        })
    }

    fn point(&self, coordinate: &Value) -> Result<Point, String> {
        let coordinate = coordinate
            .as_array()
            .filter(|value| value.len() >= 2)
            .ok_or_else(|| invalid("polygon positions require longitude and latitude"))?;
        let longitude = coordinate[0]
            .as_f64()
            .ok_or_else(|| invalid("polygon longitude must be numeric"))?;
        let latitude = coordinate[1]
            .as_f64()
            .ok_or_else(|| invalid("polygon latitude must be numeric"))?;
        if !longitude.is_finite()
            || !latitude.is_finite()
            || !(-180.0..=180.0).contains(&longitude)
            || !(-MERCATOR_MAX_LAT..=MERCATOR_MAX_LAT).contains(&latitude)
        {
            return Err(invalid(
                "polygon positions must be finite WGS84 coordinates within Web Mercator limits",
            ));
        }
        let mercator = mercator_y(latitude);
        let x = (longitude - self.west) / self.longitude_span * f64::from(self.width);
        let y = (self.north_mercator - mercator) / self.mercator_span * f64::from(self.height);
        if !x.is_finite() || !y.is_finite() {
            return Err(invalid(
                "polygon projection exceeds the finite raster coordinate range",
            ));
        }
        Ok(Point {
            x,
            y,
            longitude,
            mercator,
        })
    }
}

fn ring(grid: &Grid, value: &Value, coordinates_seen: &mut usize) -> Result<Vec<Point>, String> {
    let values = value
        .as_array()
        .filter(|coordinates| coordinates.len() >= 4)
        .ok_or_else(|| {
            invalid("polygon rings must contain at least four positions including closure")
        })?;
    *coordinates_seen = coordinates_seen
        .checked_add(values.len())
        .ok_or_else(|| "RESOURCE_LIMIT: too many clipping coordinates".to_string())?;
    if *coordinates_seen > MAX_COORDINATES {
        return Err(format!(
            "RESOURCE_LIMIT: clipping exceeds {MAX_COORDINATES} coordinates; simplify the boundary"
        ));
    }
    let points = values
        .iter()
        .map(|value| grid.point(value))
        .collect::<Result<Vec<_>, _>>()?;
    let first = points[0];
    let last = points[points.len() - 1];
    if first.longitude != last.longitude || first.mercator != last.mercator {
        return Err(invalid("polygon rings must be explicitly closed"));
    }
    // Use translated geographic/Mercator coordinates for this check. Their
    // bounded ranges avoid overflow even if the polygon is far outside a tiny
    // output extent, and translation preserves precision for small polygons.
    let area: f64 = points
        .windows(2)
        .map(|pair| {
            (pair[0].longitude - first.longitude) * (pair[1].mercator - first.mercator)
                - (pair[1].longitude - first.longitude) * (pair[0].mercator - first.mercator)
        })
        .sum();
    if !area.is_finite() || area == 0.0 {
        return Err(invalid("polygon rings must enclose a nonzero area"));
    }
    Ok(points)
}

fn inside_ring(point: Point, exterior: &[Point]) -> bool {
    let mut inside = false;
    for pair in exterior.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        let cross = (point.longitude - a.longitude) * (b.mercator - a.mercator)
            - (point.mercator - a.mercator) * (b.longitude - a.longitude);
        if cross == 0.0
            && point.longitude >= a.longitude.min(b.longitude)
            && point.longitude <= a.longitude.max(b.longitude)
            && point.mercator >= a.mercator.min(b.mercator)
            && point.mercator <= a.mercator.max(b.mercator)
        {
            return true;
        }
        if (a.mercator > point.mercator) != (b.mercator > point.mercator) {
            let t = (point.mercator - a.mercator) / (b.mercator - a.mercator);
            if point.longitude < a.longitude * (1.0 - t) + b.longitude * t {
                inside = !inside;
            }
        }
    }
    inside
}

fn add_polygon(
    grid: &Grid,
    value: &Value,
    polygon: usize,
    coordinates_seen: &mut usize,
    edges: &mut Vec<Edge>,
) -> Result<(), String> {
    let rings = value
        .as_array()
        .filter(|rings| !rings.is_empty())
        .ok_or_else(|| invalid("polygons require a nonempty exterior ring"))?;
    let exterior = ring(grid, &rings[0], coordinates_seen)?;
    add_ring_edges(grid, &exterior, polygon, edges)?;
    for value in &rings[1..] {
        let hole = ring(grid, value, coordinates_seen)?;
        if !inside_ring(hole[0], &exterior) {
            return Err(invalid(
                "polygon interior rings must start inside their exterior",
            ));
        }
        add_ring_edges(grid, &hole, polygon, edges)?;
    }
    Ok(())
}

fn add_ring_edges(
    grid: &Grid,
    ring: &[Point],
    polygon: usize,
    edges: &mut Vec<Edge>,
) -> Result<(), String> {
    for pair in ring.windows(2) {
        let (low, high) = if pair[0].y <= pair[1].y {
            (pair[0], pair[1])
        } else {
            (pair[1], pair[0])
        };
        if low.y == high.y {
            continue;
        }
        if !(high.y - low.y).is_finite() {
            return Err(invalid("polygon edge exceeds the finite projected range"));
        }
        // A non-horizontal edge intersects rows whose centers satisfy
        // low.y <= row + 0.5 < high.y. Clamp in f64 before integer conversion.
        let start = (low.y - 0.5).ceil().clamp(0.0, f64::from(grid.height)) as u32;
        let end = (high.y - 0.5).ceil().clamp(0.0, f64::from(grid.height)) as u32;
        if start < end {
            edges.push(Edge {
                start,
                end,
                polygon,
                low,
                high,
            });
        }
    }
    Ok(())
}

/// Clip a Mercator RGB raster against the union of a named GeoJSON polygon layer.
/// Outside pixels become transparent black; interior source RGB values survive.
pub fn clip_raster(
    image: RgbImage,
    geojson: &Value,
    layer: &str,
    bounds: &TileBounds,
) -> Result<RgbaImage, String> {
    if layer.trim().is_empty() {
        return Err(invalid("clip layer must not be empty"));
    }
    let grid = Grid::new(image.width(), image.height(), bounds)?;
    let features = match geojson.get("type").and_then(Value::as_str) {
        Some("FeatureCollection") => geojson
            .get("features")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .ok_or_else(|| invalid("FeatureCollection requires a features array"))?,
        Some("Feature") => std::slice::from_ref(geojson),
        _ => {
            return Err(invalid(
                "clip data must be a GeoJSON FeatureCollection or Feature",
            ))
        }
    };
    let mut edges = Vec::new();
    let mut polygon_count = 0usize;
    let mut coordinates_seen = 0usize;
    for feature in features {
        if feature
            .get("properties")
            .and_then(|properties| properties.get("layer"))
            .and_then(Value::as_str)
            != Some(layer)
        {
            continue;
        }
        if feature.get("type").and_then(Value::as_str) != Some("Feature") {
            return Err(invalid("selected clip objects must be GeoJSON Features"));
        }
        let geometry = feature
            .get("geometry")
            .ok_or_else(|| invalid("selected clip feature has no geometry"))?;
        let coordinates = geometry
            .get("coordinates")
            .ok_or_else(|| invalid("selected clip geometry has no coordinates"))?;
        let polygons = match geometry.get("type").and_then(Value::as_str) {
            Some("Polygon") => std::slice::from_ref(coordinates),
            Some("MultiPolygon") => coordinates
                .as_array()
                .filter(|polygons| !polygons.is_empty())
                .map(Vec::as_slice)
                .ok_or_else(|| invalid("MultiPolygon requires nonempty polygon coordinates"))?,
            _ => {
                return Err(invalid(format!(
                    "layer '{layer}' contains a non-polygon geometry"
                )))
            }
        };
        for polygon in polygons {
            if polygon_count >= MAX_POLYGONS {
                return Err(format!("RESOURCE_LIMIT: clipping exceeds {MAX_POLYGONS} polygons; simplify the boundary"));
            }
            add_polygon(
                &grid,
                polygon,
                polygon_count,
                &mut coordinates_seen,
                &mut edges,
            )?;
            polygon_count += 1;
        }
    }
    if polygon_count == 0 {
        return Err(invalid(format!(
            "no polygon features match layer '{layer}'"
        )));
    }
    if edges.is_empty() {
        return Err(invalid("selected polygons cover no raster pixel centers"));
    }
    edges.sort_unstable_by_key(|edge| edge.start);
    let byte_count = (grid.width as usize)
        .checked_mul(grid.height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| "RESOURCE_LIMIT: clipped raster dimensions overflow".to_string())?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(byte_count)
        .map_err(|_| "RESOURCE_LIMIT: cannot allocate clipped raster".to_string())?;
    output.resize(byte_count, 0u8);
    let input = image.as_raw();
    let mut active: Vec<Edge> = Vec::new();
    let mut crossings: Vec<(usize, f64)> = Vec::new();
    let mut spans: Vec<(u32, u32)> = Vec::new();
    let mut next = 0usize;
    let mut intersection_count = 0usize;
    let mut covered = false;
    for row in 0..grid.height {
        active.retain(|edge| edge.end > row);
        while next < edges.len() && edges[next].start <= row {
            active.push(edges[next]);
            next += 1;
        }
        intersection_count = intersection_count
            .checked_add(active.len())
            .ok_or_else(|| "RESOURCE_LIMIT: clipping complexity overflow".to_string())?;
        if intersection_count > MAX_SCANLINE_INTERSECTIONS {
            return Err(format!("RESOURCE_LIMIT: clipping exceeds {MAX_SCANLINE_INTERSECTIONS} scanline intersections; simplify the boundary or lower resolution"));
        }
        crossings.clear();
        for edge in &active {
            let t = (f64::from(row) + 0.5 - edge.low.y) / (edge.high.y - edge.low.y);
            let x = edge.low.x * (1.0 - t) + edge.high.x * t;
            if !x.is_finite() {
                return Err(invalid(
                    "polygon intersection exceeds the finite projected range",
                ));
            }
            crossings.push((edge.polygon, x));
        }
        crossings.sort_unstable_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.total_cmp(&right.1))
        });
        spans.clear();
        let mut start = 0usize;
        while start < crossings.len() {
            let polygon = crossings[start].0;
            let mut end = start + 1;
            while end < crossings.len() && crossings[end].0 == polygon {
                end += 1;
            }
            if (end - start) % 2 != 0 {
                return Err(invalid("polygon has an unpaired scanline boundary"));
            }
            for pair in crossings[start..end].chunks_exact(2) {
                let left = (pair[0].1 - 0.5).ceil().clamp(0.0, f64::from(grid.width)) as u32;
                let right = (pair[1].1 - 0.5).ceil().clamp(0.0, f64::from(grid.width)) as u32;
                if left < right {
                    spans.push((left, right));
                }
            }
            start = end;
        }
        // Polygon-local even-odd ranges become a union here. Overlap between
        // districts must not punch holes in a province's mask.
        spans.sort_unstable();
        let mut index = 0usize;
        while index < spans.len() {
            let (left, mut right) = spans[index];
            index += 1;
            while index < spans.len() && spans[index].0 <= right {
                right = right.max(spans[index].1);
                index += 1;
            }
            covered = true;
            for column in left..right {
                let pixel = row as usize * grid.width as usize + column as usize;
                output[pixel * 4..pixel * 4 + 3].copy_from_slice(&input[pixel * 3..pixel * 3 + 3]);
                output[pixel * 4 + 3] = 255;
            }
        }
    }
    if !covered {
        return Err(invalid("selected polygons cover no raster pixel centers"));
    }
    RgbaImage::from_raw(grid.width, grid.height, output)
        .ok_or_else(|| invalid("clipped raster dimensions do not match the output buffer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;
    use serde_json::json;

    fn bounds() -> TileBounds {
        TileBounds {
            west: 0.0,
            south: 0.0,
            east: 6.0,
            north: 60.0,
        }
    }
    fn image() -> RgbImage {
        RgbImage::from_pixel(6, 4, Rgb([17, 83, 149]))
    }
    fn rect(west: f64, south: f64, east: f64, north: f64) -> Value {
        json!([
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south]
        ])
    }
    fn feature(geometry: Value) -> Value {
        json!({"type":"Feature","properties":{"layer":"boundary"},"geometry":geometry})
    }
    fn polygon(rings: Vec<Value>) -> Value {
        feature(json!({"type":"Polygon","coordinates":rings}))
    }
    fn collection(features: Vec<Value>) -> Value {
        json!({"type":"FeatureCollection","features":features})
    }
    fn latitude_at_row(row: f64) -> f64 {
        (mercator_y(60.0) * (1.0 - row / 4.0))
            .sinh()
            .atan()
            .to_degrees()
    }

    #[test]
    fn overlapping_features_are_unioned_instead_of_xored() {
        let data = collection(vec![
            polygon(vec![rect(0.0, 0.0, 4.0, 60.0)]),
            polygon(vec![rect(2.0, 0.0, 6.0, 60.0)]),
        ]);
        let result = clip_raster(image(), &data, "boundary", &bounds()).unwrap();
        assert!(result.pixels().all(|pixel| pixel.0 == [17, 83, 149, 255]));
    }

    #[test]
    fn interior_ring_clears_both_alpha_and_rgb() {
        let hole = rect(2.0, latitude_at_row(3.0), 4.0, latitude_at_row(1.0));
        let data = polygon(vec![rect(0.0, 0.0, 6.0, 60.0), hole]);
        let result = clip_raster(image(), &data, "boundary", &bounds()).unwrap();
        assert_eq!(result.get_pixel(2, 1).0, [0, 0, 0, 0]);
        assert_eq!(result.get_pixel(3, 2).0, [0, 0, 0, 0]);
        assert_eq!(result.get_pixel(1, 1).0, [17, 83, 149, 255]);
        assert_eq!(result.get_pixel(3, 0).0, [17, 83, 149, 255]);
    }

    #[test]
    fn another_multipolygon_member_can_fill_part_of_a_hole() {
        let south = latitude_at_row(3.0);
        let north = latitude_at_row(1.0);
        let data = feature(json!({"type":"MultiPolygon","coordinates":[
            [rect(0.0, 0.0, 6.0, 60.0), rect(2.0, south, 4.0, north)],
            [rect(2.0, south, 3.0, north)]
        ]}));
        let result = clip_raster(image(), &data, "boundary", &bounds()).unwrap();
        assert_eq!(result.get_pixel(2, 1).0, [17, 83, 149, 255]);
        assert_eq!(result.get_pixel(3, 1).0, [0, 0, 0, 0]);
    }

    #[test]
    fn latitude_is_projected_non_linearly_before_pixel_center_sampling() {
        let bounds = TileBounds {
            west: 0.0,
            south: 0.0,
            east: 4.0,
            north: 80.0,
        };
        let data = polygon(vec![rect(0.0, 40.0, 4.0, 80.0)]);
        let result = clip_raster(
            RgbImage::from_pixel(4, 4, Rgb([1, 2, 3])),
            &data,
            "boundary",
            &bounds,
        )
        .unwrap();
        // 40 degrees lies at ~2.75 rows in this Mercator raster. A linear
        // latitude mapping would incorrectly clear row 2 as well.
        assert_eq!(result.get_pixel(1, 2).0, [1, 2, 3, 255]);
        assert_eq!(result.get_pixel(1, 3).0, [0, 0, 0, 0]);
    }

    #[test]
    fn pixel_centers_determine_coverage_at_subpixel_edges() {
        let data = polygon(vec![rect(0.6, 0.0, 2.4, 60.0)]);
        let result = clip_raster(image(), &data, "boundary", &bounds()).unwrap();
        assert_eq!(result.get_pixel(0, 0).0, [0, 0, 0, 0]);
        assert_eq!(result.get_pixel(1, 0).0, [17, 83, 149, 255]);
        assert_eq!(result.get_pixel(2, 0).0, [0, 0, 0, 0]);
    }

    #[test]
    fn refuses_missing_layers_points_and_empty_pixel_coverage() {
        let data = polygon(vec![rect(0.0, 0.0, 6.0, 60.0)]);
        assert!(clip_raster(image(), &data, "other", &bounds())
            .unwrap_err()
            .starts_with("CLIP_INVALID:"));
        let point = feature(json!({"type":"Point","coordinates":[1,1]}));
        assert!(clip_raster(image(), &point, "boundary", &bounds())
            .unwrap_err()
            .contains("non-polygon"));
        let outside = polygon(vec![rect(10.0, 10.0, 12.0, 20.0)]);
        assert!(clip_raster(image(), &outside, "boundary", &bounds())
            .unwrap_err()
            .contains("no raster pixel centers"));
    }

    #[test]
    fn rejects_unclosed_degenerate_or_invalid_coordinate_rings() {
        let cases = [
            json!([[0, 0], [1, 0], [1, 1], [0, 1]]),
            json!([[0, 0], [1, 0], [2, 0], [0, 0]]),
            json!([[0, 0], [1, 0], [1, 91], [0, 0]]),
            json!([[0, 0], [1, 0], ["invalid", 1], [0, 0]]),
        ];
        for ring in cases {
            let data = polygon(vec![ring]);
            assert!(clip_raster(image(), &data, "boundary", &bounds())
                .unwrap_err()
                .starts_with("CLIP_INVALID:"));
        }
        let data = polygon(vec![
            rect(0.0, 0.0, 6.0, 60.0),
            rect(10.0, 10.0, 12.0, 20.0),
        ]);
        assert!(clip_raster(image(), &data, "boundary", &bounds())
            .unwrap_err()
            .contains("interior rings"));
    }
}
