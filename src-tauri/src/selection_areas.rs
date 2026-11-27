use serde::{Deserialize, Serialize};

pub type Ring = Vec<[f64; 2]>;
pub type Area = Vec<Ring>;

/// WGS84 GeoJSON order: polygons, rings (exterior first), longitude/latitude.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "WireAreas")]
pub struct SelectionAreas(pub Vec<Area>);

#[derive(Deserialize)]
#[serde(untagged)]
enum WireAreas {
    Multi(Vec<Vec<Vec<Vec<f64>>>>),
    Legacy3d(Vec<Vec<f64>>),
    LegacyOsm(Vec<crate::commands::PolygonCoord>),
}

impl TryFrom<WireAreas> for SelectionAreas {
    type Error = String;
    fn try_from(wire: WireAreas) -> Result<Self, String> {
        let parts = match wire {
            WireAreas::Multi(parts) => parts
                .into_iter()
                .map(|part| {
                    part.into_iter()
                        .map(horizontal_ring)
                        .collect::<Result<Area, _>>()
                })
                .collect::<Result<Vec<_>, _>>()?,
            WireAreas::Legacy3d(ring) => vec![vec![horizontal_ring(ring)?]],
            WireAreas::LegacyOsm(points) => {
                vec![vec![points.into_iter().map(|p| [p.lng, p.lat]).collect()]]
            }
        };
        if parts.is_empty()
            || parts.iter().any(|area| {
                area.is_empty()
                    || area.iter().any(|ring| {
                        ring.len() < 3
                            || ring.iter().any(|p| {
                                !(-180.0..=180.0).contains(&p[0]) || !(-90.0..=90.0).contains(&p[1])
                            })
                    })
            })
        {
            return Err("选区包含无效的多边形坐标".into());
        }
        Ok(Self(parts))
    }
}

// GeoJSON positions may include altitude. Both area filters work in lon/lat.
fn horizontal_ring(points: Vec<Vec<f64>>) -> Result<Ring, String> {
    points
        .into_iter()
        .map(|p| match p.as_slice() {
            [longitude, latitude, ..] => Ok([*longitude, *latitude]),
            _ => Err("选区坐标缺少经纬度".into()),
        })
        .collect()
}

pub fn ring_bounds(ring: &[[f64; 2]]) -> [f64; 4] {
    ring.iter().fold(
        [
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        ],
        |b, p| {
            [
                b[0].min(p[0]),
                b[1].min(p[1]),
                b[2].max(p[0]),
                b[3].max(p[1]),
            ]
        },
    )
}
