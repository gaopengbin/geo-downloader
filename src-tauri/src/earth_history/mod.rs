//! Independent Earth historical imagery protocol adapter; no Earth/WASM runtime.
pub mod catalog;
pub mod decoder;
pub mod planner;
pub mod raster;
pub mod transport;
pub mod keyhole;
pub(crate) mod wire;
pub type Result<T> = std::result::Result<T, String>;
#[cfg(test)]
mod tests;
pub fn validate_id(id: &str) -> Result<()> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("EARTH_PLAN: invalid snapshot identity".into());
    }
    Ok(())
}

pub fn is_source(id:&str)->bool{id.starts_with("earth_history_") || id.starts_with("earth_keyhole_")}
pub fn source(id:&str)->Result<crate::config::TileSource>{if id.starts_with("earth_keyhole_"){keyhole::source(id)}else{planner::source(id)}}
pub fn write_manifest_for_grid(path:&std::path::Path,id:&str,bounds:&crate::tile::TileBounds,width:u32,height:u32,zoom:u8)->Result<()> {
    if id.starts_with("earth_keyhole_") {
        let p=|lon:f64,lat:f64|[6378137.*lon.to_radians(),6378137.*(std::f64::consts::PI/4.+lat.to_radians()/2.).tan().ln()];let low=p(bounds.west,bounds.south);let high=p(bounds.east,bounds.north);
        keyhole::manifest(path,id,serde_json::json!({"crs":"EPSG:3857","zoom":zoom,"width":width,"height":height,"bounds":[low[0],low[1],high[0],high[1]],"transform":[low[0],(high[0]-low[0])/width as f64,0.,high[1],0.,-(high[1]-low[1])/height as f64]}))
    }else{planner::write_manifest_for_grid(path,id,bounds,width,height,zoom)}
}
