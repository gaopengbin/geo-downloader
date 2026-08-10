use crate::tiles3d::tileset::{BoundingVolume, Tile, Tileset};
use std::collections::HashMap;

pub type TileTransform = [f64; 16];

pub const IDENTITY_TRANSFORM: TileTransform = [
    1.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0,
    0.0, 0.0, 1.0, 0.0,
    0.0, 0.0, 0.0, 1.0,
];

fn multiply_transforms(left: &TileTransform, right: &TileTransform) -> TileTransform {
    let mut result = [0.0; 16];
    for column in 0..4 {
        for row in 0..4 {
            result[column * 4 + row] = (0..4)
                .map(|k| left[k * 4 + row] * right[column * 4 + k])
                .sum();
        }
    }
    result
}

fn cumulative_transform(parent: &TileTransform, local: Option<&Vec<f64>>) -> TileTransform {
    let Some(values) = local.filter(|values| values.len() == 16 && values.iter().all(|v| v.is_finite())) else {
        return *parent;
    };
    let mut matrix = [0.0; 16];
    matrix.copy_from_slice(values);
    multiply_transforms(parent, &matrix)
}

fn transform_point(matrix: &TileTransform, point: [f64; 3]) -> [f64; 3] {
    let [x, y, z] = point;
    [
        matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
        matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
        matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
    ]
}

fn transform_vector(matrix: &TileTransform, vector: [f64; 3]) -> [f64; 3] {
    let [x, y, z] = vector;
    [
        matrix[0] * x + matrix[4] * y + matrix[8] * z,
        matrix[1] * x + matrix[5] * y + matrix[9] * z,
        matrix[2] * x + matrix[6] * y + matrix[10] * z,
    ]
}

fn linear_scale_upper_bound(matrix: &TileTransform) -> f64 {
    let max_column_sum = (0..3)
        .map(|column| (0..3).map(|row| matrix[column * 4 + row].abs()).sum::<f64>())
        .fold(0.0, f64::max);
    let max_row_sum = (0..3)
        .map(|row| (0..3).map(|column| matrix[column * 4 + row].abs()).sum::<f64>())
        .fold(0.0, f64::max);
    (max_column_sum * max_row_sum).sqrt()
}

// ============================================================
// 空间过滤：包围体与多边形相交判定
// ============================================================

/// 用户选区多边形（度，WGS-84）
#[derive(Debug, Clone)]
pub struct SelectionRegion {
    /// 多边形顶点 [[lng, lat], ...]
    pub polygon: Vec<[f64; 2]>,
    /// 最小外接矩形 [west, south, east, north]
    pub mbr: [f64; 4],
}

impl SelectionRegion {
    pub fn new(coords: &[Vec<f64>]) -> Self {
        let polygon: Vec<[f64; 2]> = coords
            .iter()
            .filter(|c| c.len() >= 2)
            .map(|c| [c[0], c[1]])
            .collect();

        let mut west = f64::MAX;
        let mut south = f64::MAX;
        let mut east = f64::MIN;
        let mut north = f64::MIN;
        for p in &polygon {
            west = west.min(p[0]);
            south = south.min(p[1]);
            east = east.max(p[0]);
            north = north.max(p[1]);
        }

        SelectionRegion {
            polygon,
            mbr: [west, south, east, north],
        }
    }

    /// 判断一个经纬度矩形是否与选区相交
    /// rect: [west, south, east, north] 度
    pub fn intersects_rect(&self, rect: [f64; 4]) -> bool {
        let [rw, rs, re, rn] = rect;
        let [mw, ms, me, mn] = self.mbr;

        // 第一级：MBR 快速排除
        if rw > me || re < mw || rs > mn || rn < ms {
            return false;
        }

        // 如果多边形顶点不超过 2 个（退化情况），MBR 相交即可
        if self.polygon.len() < 3 {
            return true;
        }

        // 第二级：精确多边形-矩形相交判定
        // 情况 1：矩形任一顶点在多边形内
        let rect_corners = [
            [rw, rs],
            [re, rs],
            [re, rn],
            [rw, rn],
        ];
        for corner in &rect_corners {
            if point_in_polygon(corner, &self.polygon) {
                return true;
            }
        }

        // 情况 2：多边形任一顶点在矩形内
        for vertex in &self.polygon {
            if vertex[0] >= rw && vertex[0] <= re && vertex[1] >= rs && vertex[1] <= rn {
                return true;
            }
        }

        // 情况 3：多边形边与矩形边相交
        let rect_edges = [
            ([rw, rs], [re, rs]),
            ([re, rs], [re, rn]),
            ([re, rn], [rw, rn]),
            ([rw, rn], [rw, rs]),
        ];
        let n = self.polygon.len();
        for i in 0..n {
            let j = (i + 1) % n;
            let poly_edge = (self.polygon[i], self.polygon[j]);
            for rect_edge in &rect_edges {
                if segments_intersect(poly_edge.0, poly_edge.1, rect_edge.0, rect_edge.1) {
                    return true;
                }
            }
        }

        false
    }
}

/// 射线法判断点是否在多边形内
fn point_in_polygon(point: &[f64; 2], polygon: &[[f64; 2]]) -> bool {
    let (px, py) = (point[0], point[1]);
    let n = polygon.len();
    let mut inside = false;

    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (polygon[i][0], polygon[i][1]);
        let (xj, yj) = (polygon[j][0], polygon[j][1]);

        if ((yi > py) != (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// 判断两条线段是否相交（标准叉积法）
fn segments_intersect(a1: [f64; 2], a2: [f64; 2], b1: [f64; 2], b2: [f64; 2]) -> bool {
    let d1 = cross(b1, b2, a1);
    let d2 = cross(b1, b2, a2);
    let d3 = cross(a1, a2, b1);
    let d4 = cross(a1, a2, b2);

    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        return true;
    }

    // 共线重叠情况
    if d1 == 0.0 && on_segment(b1, b2, a1) {
        return true;
    }
    if d2 == 0.0 && on_segment(b1, b2, a2) {
        return true;
    }
    if d3 == 0.0 && on_segment(a1, a2, b1) {
        return true;
    }
    if d4 == 0.0 && on_segment(a1, a2, b2) {
        return true;
    }
    false
}

fn cross(o: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

fn on_segment(p: [f64; 2], q: [f64; 2], r: [f64; 2]) -> bool {
    r[0] >= p[0].min(q[0])
        && r[0] <= p[0].max(q[0])
        && r[1] >= p[1].min(q[1])
        && r[1] <= p[1].max(q[1])
}

// ============================================================
// 包围体 → 经纬度矩形转换
// ============================================================

impl BoundingVolume {
    /// 将包围体转为经纬度矩形 [west, south, east, north]（度），用于空间过滤
    /// region 类型直接转换；box/sphere 类型计算近似外接矩形
    pub fn to_filter_rect(&self) -> Option<[f64; 4]> {
        self.to_filter_rect_with_transform(&IDENTITY_TRANSFORM)
    }

    /// 3D Tiles 的 transform 使用列主序，并且需要沿 tile 树逐级累乘。
    /// region 已经是 EPSG:4979 全局坐标，规范规定不应用 tile transform。
    pub fn to_filter_rect_with_transform(
        &self,
        transform: &TileTransform,
    ) -> Option<[f64; 4]> {
        if let Some(ref region) = self.region {
            if region.len() >= 4 {
                return Some([
                    region[0].to_degrees(),
                    region[1].to_degrees(),
                    region[2].to_degrees(),
                    region[3].to_degrees(),
                ]);
            }
        }

        if let Some(ref b) = self.box_volume {
            return self.box_to_rect(b, transform);
        }

        if let Some(ref s) = self.sphere {
            return self.sphere_to_rect(s, transform);
        }

        None
    }

    /// OBB → 近似经纬度矩形
    /// box: [cx, cy, cz, x0, x1, x2, y0, y1, y2, z0, z1, z2]
    fn box_to_rect(&self, b: &[f64], transform: &TileTransform) -> Option<[f64; 4]> {
        if b.len() < 12 {
            return None;
        }
        let center = transform_point(transform, [b[0], b[1], b[2]]);

        // 8 个顶点 = center ± x_half ± y_half ± z_half
        let half_axes = [
            transform_vector(transform, [b[3], b[4], b[5]]),
            transform_vector(transform, [b[6], b[7], b[8]]),
            transform_vector(transform, [b[9], b[10], b[11]]),
        ];

        let mut min_x = f64::MAX;
        let mut max_x = f64::MIN;
        let mut min_y = f64::MAX;
        let mut max_y = f64::MIN;

        for sx in &[-1.0f64, 1.0] {
            for sy in &[-1.0f64, 1.0] {
                for sz in &[-1.0f64, 1.0] {
                    let x = center[0] + sx * half_axes[0][0] + sy * half_axes[1][0] + sz * half_axes[2][0];
                    let y = center[1] + sx * half_axes[0][1] + sy * half_axes[1][1] + sz * half_axes[2][1];
                    let z = center[2] + sx * half_axes[0][2] + sy * half_axes[1][2] + sz * half_axes[2][2];

                    // ECEF → 经纬度（近似）
                    let (lng, lat) = ecef_to_lonlat(x, y, z);
                    min_x = min_x.min(lng);
                    max_x = max_x.max(lng);
                    min_y = min_y.min(lat);
                    max_y = max_y.max(lat);
                }
            }
        }

        Some([min_x, min_y, max_x, max_y])
    }

    /// Sphere → 近似经纬度矩形
    fn sphere_to_rect(&self, s: &[f64], transform: &TileTransform) -> Option<[f64; 4]> {
        if s.len() < 4 {
            return None;
        }
        let center = transform_point(transform, [s[0], s[1], s[2]]);
        let r = s[3] * linear_scale_upper_bound(transform);
        let (lng, lat) = ecef_to_lonlat(center[0], center[1], center[2]);

        // 近似：在地表，1度纬度约 111km
        let r_km = r / 1000.0;
        let dlat = r_km / 111.0;
        let dlng = r_km / (111.0 * lat.to_radians().cos().max(0.01));

        Some([lng - dlng, lat - dlat, lng + dlng, lat + dlat])
    }
}

/// ECEF 坐标 → WGS-84 经纬度（度）
/// 使用 Bowring 迭代法，精度优于 0.001″
fn ecef_to_lonlat(x: f64, y: f64, z: f64) -> (f64, f64) {
    let lng = y.atan2(x).to_degrees();

    // WGS-84 椭球参数
    const A: f64 = 6_378_137.0; // 长半轴
    const E2: f64 = 0.006_694_379_990_14; // 第一偏心率^2

    let r = (x * x + y * y).sqrt();
    // 初始近似（球面）
    let mut lat = z.atan2(r);
    // 迭代 3 次即可收敛到亚毫米精度
    for _ in 0..3 {
        let sin_lat = lat.sin();
        let n = A / (1.0 - E2 * sin_lat * sin_lat).sqrt();
        lat = (z + E2 * n * sin_lat).atan2(r);
    }

    (lng, lat.to_degrees())
}

// ============================================================
// 树过滤：递归过滤 tileset 树
// ============================================================

/// 过滤后的瓦片信息
#[derive(Debug, Clone)]
pub struct FilterResult {
    /// 过滤后的 tileset（可序列化写入文件）
    pub tileset: Tileset,
    /// 需要下载的内容 URI 列表（相对于 tileset.json 的路径）
    pub download_uris: Vec<String>,
    /// 每个内容 URI 所在 tile 的累计变换，供外部 tileset 继续继承。
    pub uri_transforms: HashMap<String, TileTransform>,
    /// 过滤前的总节点数
    pub original_count: usize,
    /// 过滤后保留的节点数
    pub filtered_count: usize,
    /// 有内容需下载的节点数
    pub content_count: usize,
}

/// 对 tileset 进行空间过滤
pub fn filter_tileset(tileset: &Tileset, region: &SelectionRegion) -> FilterResult {
    filter_tileset_with_parent_transform(tileset, region, &IDENTITY_TRANSFORM)
}

pub fn filter_tileset_with_parent_transform(
    tileset: &Tileset,
    region: &SelectionRegion,
    parent_transform: &TileTransform,
) -> FilterResult {
    let original_count = count_tiles(&tileset.root);
    let mut download_uris = Vec::new();
    let mut uri_transforms = HashMap::new();
    let mut filtered_count = 0usize;
    let mut content_count = 0usize;

    let filtered_root = filter_tile(
        &tileset.root,
        region,
        &mut download_uris,
        &mut uri_transforms,
        &mut filtered_count,
        &mut content_count,
        parent_transform,
    );

    // 根节点不能为空——如果完全不相交，返回一个空壳
    let root = filtered_root.unwrap_or_else(|| {
        let mut empty = tileset.root.clone();
        empty.children = None;
        empty.content = None;
        empty.contents = None;
        empty
    });

    let mut filtered_tileset = tileset.clone();
    filtered_tileset.root = root;

    FilterResult {
        tileset: filtered_tileset,
        download_uris,
        uri_transforms,
        original_count,
        filtered_count,
        content_count,
    }
}

/// 无空间过滤——收集全部内容 URI（用于无选区时下载整个 tileset）
pub fn filter_tileset_all(tileset: &Tileset) -> FilterResult {
    let mut download_uris = Vec::new();
    let mut content_count = 0usize;
    collect_all_uris(&tileset.root, &mut download_uris, &mut content_count);
    let total = count_tiles(&tileset.root);

    FilterResult {
        tileset: tileset.clone(),
        download_uris,
        uri_transforms: HashMap::new(),
        original_count: total,
        filtered_count: total,
        content_count,
    }
}

fn collect_all_uris(tile: &Tile, uris: &mut Vec<String>, count: &mut usize) {
    for uri in tile.content_uris() {
        uris.push(uri.to_string());
        *count += 1;
    }
    if let Some(ref children) = tile.children {
        for child in children {
            collect_all_uris(child, uris, count);
        }
    }
}

fn filter_tile(
    tile: &Tile,
    region: &SelectionRegion,
    download_uris: &mut Vec<String>,
    uri_transforms: &mut HashMap<String, TileTransform>,
    filtered_count: &mut usize,
    content_count: &mut usize,
    parent_transform: &TileTransform,
) -> Option<Tile> {
    let transform = cumulative_transform(parent_transform, tile.transform.as_ref());
    let self_intersects = tile
        .bounding_volume
        .to_filter_rect_with_transform(&transform)
        .map(|rect| region.intersects_rect(rect))
        .unwrap_or(true); // 无法判定包围体时，保守保留

    // 递归过滤子节点
    let filtered_children: Vec<Tile> = tile
        .children
        .as_ref()
        .map(|children| {
            children
                .iter()
                .filter_map(|child| {
                    filter_tile(
                        child,
                        region,
                        download_uris,
                        uri_transforms,
                        filtered_count,
                        content_count,
                        &transform,
                    )
                })
                .collect()
        })
        .unwrap_or_default();

    // 规则 3：自身和子孙都不在选区内 → 剪枝
    if !self_intersects && filtered_children.is_empty() {
        return None;
    }

    *filtered_count += 1;

    let mut result = tile.clone();
    result.children = if filtered_children.is_empty() {
        None
    } else {
        Some(filtered_children)
    };

    if self_intersects {
        // 收集需要下载的 URI
        for uri in tile.content_uris() {
            download_uris.push(uri.to_string());
            uri_transforms.entry(uri.to_string()).or_insert(transform);
            *content_count += 1;
        }
    } else {
        // 规则 2：保留结构节点但清除内容
        result.content = None;
        result.contents = None;
    }

    Some(result)
}

fn count_tiles(tile: &Tile) -> usize {
    let mut count = 1;
    if let Some(ref children) = tile.children {
        for child in children {
            count += count_tiles(child);
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_point_in_polygon() {
        let polygon = vec![[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        assert!(point_in_polygon(&[5.0, 5.0], &polygon));
        assert!(!point_in_polygon(&[15.0, 5.0], &polygon));
    }

    #[test]
    fn test_intersects_rect() {
        let region = SelectionRegion::new(&[
            vec![0.0, 0.0],
            vec![10.0, 0.0],
            vec![10.0, 10.0],
            vec![0.0, 10.0],
        ]);

        // 完全内部
        assert!(region.intersects_rect([2.0, 2.0, 8.0, 8.0]));
        // 完全外部
        assert!(!region.intersects_rect([20.0, 20.0, 30.0, 30.0]));
        // 部分重叠
        assert!(region.intersects_rect([5.0, 5.0, 15.0, 15.0]));
        // 完全包含选区
        assert!(region.intersects_rect([-5.0, -5.0, 15.0, 15.0]));
    }

    #[test]
    fn test_segments_intersect() {
        assert!(segments_intersect([0.0, 0.0], [10.0, 10.0], [0.0, 10.0], [10.0, 0.0]));
        assert!(!segments_intersect([0.0, 0.0], [5.0, 5.0], [6.0, 6.0], [10.0, 10.0]));
    }

    #[test]
    fn applies_ancestor_transform_to_child_box() {
        let tileset: Tileset = serde_json::from_value(serde_json::json!({
            "asset": { "version": "1.1" },
            "geometricError": 1000.0,
            "root": {
                "boundingVolume": { "box": [6378137.0, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0, 100.0] },
                "geometricError": 1000.0,
                "transform": [0.0, 1.0, 0.0, 0.0, -1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0],
                "children": [{
                    "boundingVolume": { "box": [6378137.0, 0.0, 0.0, 50.0, 0.0, 0.0, 0.0, 50.0, 0.0, 0.0, 0.0, 50.0] },
                    "geometricError": 0.0,
                    "content": { "uri": "tile.b3dm" }
                }]
            }
        })).unwrap();
        let region = SelectionRegion::new(&[
            vec![89.9, -0.1],
            vec![90.1, -0.1],
            vec![90.1, 0.1],
            vec![89.9, 0.1],
        ]);

        let result = filter_tileset(&tileset, &region);

        assert_eq!(result.download_uris, vec!["tile.b3dm"]);
        assert_eq!(result.filtered_count, 2);
        assert_eq!(result.uri_transforms["tile.b3dm"][1], 1.0);
    }
}
