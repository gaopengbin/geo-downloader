use crate::fs_util::atomic_write;
use crate::tile::{bounds_to_mercator, TileBounds};
use std::path::{Path, PathBuf};

const EPSG_3857_WKT: &str = "PROJCS[\"WGS_1984_Web_Mercator_Auxiliary_Sphere\",GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137.0,298.257223563]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]],PROJECTION[\"Mercator_Auxiliary_Sphere\"],PARAMETER[\"False_Easting\",0.0],PARAMETER[\"False_Northing\",0.0],PARAMETER[\"Central_Meridian\",0.0],PARAMETER[\"Standard_Parallel_1\",0.0],PARAMETER[\"Auxiliary_Sphere_Type\",0.0],UNIT[\"Meter\",1.0]]";
const EPSG_4326_WKT: &str = "GEOGCS[\"GCS_WGS_1984\",DATUM[\"D_WGS_1984\",SPHEROID[\"WGS_1984\",6378137.0,298.257223563]],PRIMEM[\"Greenwich\",0.0],UNIT[\"Degree\",0.0174532925199433]]";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarCrs {
    WebMercator,
    Wgs84,
}

pub fn write_geotiff_sidecars(
    tif_path: &Path,
    bounds: &TileBounds,
    width: u32,
    height: u32,
    crs: SidecarCrs,
) -> Result<(PathBuf, PathBuf), String> {
    if width == 0 || height == 0 {
        return Err("无法为零尺寸影像生成辅助文件".to_string());
    }

    let (west, south, east, north, wkt) = match crs {
        SidecarCrs::WebMercator => {
            let (west, south, east, north) = bounds_to_mercator(bounds);
            (west, south, east, north, EPSG_3857_WKT)
        }
        SidecarCrs::Wgs84 => (
            bounds.west,
            bounds.south,
            bounds.east,
            bounds.north,
            EPSG_4326_WKT,
        ),
    };

    let x_size = (east - west) / width as f64;
    let y_size = (north - south) / height as f64;
    if !x_size.is_finite() || !y_size.is_finite() || x_size <= 0.0 || y_size <= 0.0 {
        return Err("GeoTIFF 边界无效，无法生成辅助文件".to_string());
    }

    // World file stores the center coordinate of the upper-left pixel.
    let world = format!(
        "{x_size:.15}\n0.000000000000000\n0.000000000000000\n-{y_size:.15}\n{center_x:.15}\n{center_y:.15}\n",
        center_x = west + x_size / 2.0,
        center_y = north - y_size / 2.0,
    );

    let tfw_path = tif_path.with_extension("tfw");
    let prj_path = tif_path.with_extension("prj");
    atomic_write(&tfw_path, world.as_bytes())
        .map_err(|error| format!("写入 {} 失败: {error}", tfw_path.display()))?;
    atomic_write(&prj_path, wkt.as_bytes())
        .map_err(|error| format!("写入 {} 失败: {error}", prj_path.display()))?;

    Ok((tfw_path, prj_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_world(path: &Path) -> Vec<f64> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| line.parse::<f64>().unwrap())
            .collect()
    }

    #[test]
    fn writes_web_mercator_world_file_using_pixel_centers() {
        let dir = tempfile::tempdir().unwrap();
        let tif = dir.path().join("map.tif");
        let bounds = TileBounds {
            north: 0.0,
            south: -1.0,
            east: 1.0,
            west: 0.0,
        };

        let (tfw, prj) = write_geotiff_sidecars(
            &tif,
            &bounds,
            256,
            256,
            SidecarCrs::WebMercator,
        )
        .unwrap();

        let values = parse_world(&tfw);
        let (west, south, east, north) = bounds_to_mercator(&bounds);
        let x_size = (east - west) / 256.0;
        let y_size = (north - south) / 256.0;
        assert!((values[0] - x_size).abs() < 1e-9);
        assert!((values[3] + y_size).abs() < 1e-9);
        assert!((values[4] - (west + x_size / 2.0)).abs() < 1e-9);
        assert!((values[5] - (north - y_size / 2.0)).abs() < 1e-9);
        assert!(std::fs::read_to_string(prj).unwrap().contains("Web_Mercator"));
    }

    #[test]
    fn writes_wgs84_sidecars_for_dem() {
        let dir = tempfile::tempdir().unwrap();
        let tif = dir.path().join("dem.tif");
        let bounds = TileBounds {
            north: 40.0,
            south: 39.0,
            east: 117.0,
            west: 116.0,
        };

        let (tfw, prj) =
            write_geotiff_sidecars(&tif, &bounds, 2, 4, SidecarCrs::Wgs84).unwrap();

        assert_eq!(parse_world(&tfw), vec![0.5, 0.0, 0.0, -0.25, 116.25, 39.875]);
        assert!(std::fs::read_to_string(prj).unwrap().contains("GCS_WGS_1984"));
    }
}
