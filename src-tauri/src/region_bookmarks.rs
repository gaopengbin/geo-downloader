//! Persistent download-region bookmarks backed by SQLite.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use uuid::Uuid;

const MAX_NAME_CHARS: usize = 80;
const MAX_GEOMETRY_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookmarkBounds {
    pub north: f64,
    pub south: f64,
    pub east: f64,
    pub west: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookmarkPoint {
    pub lat: f64,
    pub lng: f64,
}

pub type BookmarkPolygon = Vec<Vec<BookmarkPoint>>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegionBookmark {
    pub id: String,
    pub name: String,
    pub bounds: BookmarkBounds,
    pub polygon: Option<BookmarkPolygon>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct RegionBookmarkStore {
    db_path: PathBuf,
}

static GLOBAL: OnceLock<RegionBookmarkStore> = OnceLock::new();
static GLOBAL_INIT: Mutex<()> = Mutex::new(());

impl RegionBookmarkStore {
    pub fn global() -> Result<&'static Self, String> {
        if let Some(store) = GLOBAL.get() {
            return Ok(store);
        }

        let _guard = GLOBAL_INIT
            .lock()
            .map_err(|_| "范围书签数据库初始化锁异常".to_string())?;
        if let Some(store) = GLOBAL.get() {
            return Ok(store);
        }

        let store = Self::open_at(&data_dir()?)?;
        GLOBAL
            .set(store)
            .map_err(|_| "范围书签数据库初始化失败".to_string())?;
        GLOBAL
            .get()
            .ok_or_else(|| "范围书签数据库初始化失败".to_string())
    }

    pub(crate) fn open_at(data_dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir)
            .map_err(|error| format!("创建范围书签数据目录失败: {error}"))?;
        let store = Self {
            db_path: data_dir.join("region-bookmarks.db"),
        };
        store.with_connection(|connection| {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS region_bookmarks (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    bounds_json TEXT NOT NULL,
                    polygon_json TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_region_bookmarks_updated_at
                    ON region_bookmarks(updated_at DESC);",
            )?;
            Ok(())
        })?;
        Ok(store)
    }

    fn connection(&self) -> Result<Connection, String> {
        let connection = Connection::open(&self.db_path)
            .map_err(|error| format!("打开范围书签数据库失败: {error}"))?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(|error| format!("设置范围书签数据库超时失败: {error}"))?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(|error| format!("启用范围书签数据库 WAL 失败: {error}"))?;
        connection
            .pragma_update(None, "synchronous", "NORMAL")
            .map_err(|error| format!("设置范围书签数据库同步模式失败: {error}"))?;
        Ok(connection)
    }

    fn with_connection<T>(
        &self,
        operation: impl FnOnce(&mut Connection) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut connection = self.connection()?;
        operation(&mut connection).map_err(|error| format!("范围书签数据库操作失败: {error}"))
    }

    pub fn list(&self) -> Result<Vec<RegionBookmark>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, bounds_json, polygon_json, created_at, updated_at
                 FROM region_bookmarks
                 ORDER BY updated_at DESC, rowid DESC",
            )?;
            let bookmarks = statement.query_map([], row_to_bookmark)?.collect();
            bookmarks
        })
    }

    pub fn create(
        &self,
        name: String,
        bounds: BookmarkBounds,
        polygon: Option<BookmarkPolygon>,
    ) -> Result<RegionBookmark, String> {
        let name = validate_name(name)?;
        validate_bounds(&bounds)?;
        validate_polygon(polygon.as_ref())?;

        let now = Utc::now();
        let bookmark = RegionBookmark {
            id: Uuid::new_v4().to_string(),
            name,
            bounds,
            polygon,
            created_at: now,
            updated_at: now,
        };
        let bounds_json = serde_json::to_string(&bookmark.bounds)
            .map_err(|error| format!("序列化范围书签边界失败: {error}"))?;
        let polygon_json = bookmark
            .polygon
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| format!("序列化范围书签几何失败: {error}"))?;
        validate_geometry_size(&bounds_json, polygon_json.as_deref())?;

        self.with_connection(|connection| {
            connection.execute(
                "INSERT INTO region_bookmarks
                 (id, name, bounds_json, polygon_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    bookmark.id,
                    bookmark.name,
                    bounds_json,
                    polygon_json,
                    bookmark.created_at.to_rfc3339(),
                    bookmark.updated_at.to_rfc3339(),
                ],
            )?;
            Ok(())
        })?;
        Ok(bookmark)
    }

    pub fn rename(&self, id: &str, name: String) -> Result<RegionBookmark, String> {
        let name = validate_name(name)?;
        let updated_at = Utc::now();
        let changed = self.with_connection(|connection| {
            connection.execute(
                "UPDATE region_bookmarks SET name = ?1, updated_at = ?2 WHERE id = ?3",
                params![name, updated_at.to_rfc3339(), id],
            )
        })?;
        if changed == 0 {
            return Err("范围书签不存在或已被删除".to_string());
        }
        self.get(id)?
            .ok_or_else(|| "范围书签不存在或已被删除".to_string())
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let changed = self.with_connection(|connection| {
            connection.execute("DELETE FROM region_bookmarks WHERE id = ?1", params![id])
        })?;
        if changed == 0 {
            return Err("范围书签不存在或已被删除".to_string());
        }
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Option<RegionBookmark>, String> {
        self.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, bounds_json, polygon_json, created_at, updated_at
                 FROM region_bookmarks WHERE id = ?1",
            )?;
            let mut rows = statement.query(params![id])?;
            rows.next()?.map(row_to_bookmark).transpose()
        })
    }
}

fn row_to_bookmark(row: &Row<'_>) -> rusqlite::Result<RegionBookmark> {
    let bounds_json: String = row.get(2)?;
    let polygon_json: Option<String> = row.get(3)?;
    let created_at: String = row.get(4)?;
    let updated_at: String = row.get(5)?;
    Ok(RegionBookmark {
        id: row.get(0)?,
        name: row.get(1)?,
        bounds: parse_json(bounds_json, 2)?,
        polygon: polygon_json.map(|value| parse_json(value, 3)).transpose()?,
        created_at: parse_datetime(created_at, 4)?,
        updated_at: parse_datetime(updated_at, 5)?,
    })
}

fn parse_json<T: serde::de::DeserializeOwned>(value: String, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            column,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn parse_datetime(value: String, column: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                column,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
}

fn validate_name(name: String) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("请输入书签名称".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("书签名称不能超过 {MAX_NAME_CHARS} 个字符"));
    }
    Ok(name)
}

fn validate_bounds(bounds: &BookmarkBounds) -> Result<(), String> {
    if ![bounds.north, bounds.south, bounds.east, bounds.west]
        .iter()
        .all(|value| value.is_finite())
    {
        return Err("书签范围包含无效坐标".to_string());
    }
    if bounds.north < bounds.south {
        return Err("书签范围的南北边界无效".to_string());
    }
    Ok(())
}

fn validate_polygon(polygon: Option<&BookmarkPolygon>) -> Result<(), String> {
    let Some(polygon) = polygon else {
        return Ok(());
    };
    if polygon.iter().any(|ring| {
        ring.is_empty()
            || ring
                .iter()
                .any(|point| !point.lat.is_finite() || !point.lng.is_finite())
    }) {
        return Err("书签几何包含无效坐标".to_string());
    }
    Ok(())
}

fn validate_geometry_size(bounds_json: &str, polygon_json: Option<&str>) -> Result<(), String> {
    let size = bounds_json.len() + polygon_json.map(str::len).unwrap_or_default();
    if size > MAX_GEOMETRY_BYTES {
        return Err("当前范围过于复杂，无法保存为书签".to_string());
    }
    Ok(())
}

fn data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|path| path.join("geo-downloader"))
        .ok_or_else(|| "无法获取范围书签数据目录".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn bounds() -> BookmarkBounds {
        BookmarkBounds {
            north: 35.0,
            south: 34.0,
            east: 109.0,
            west: 108.0,
        }
    }

    fn polygon(points: usize) -> BookmarkPolygon {
        vec![(0..points)
            .map(|index| BookmarkPoint {
                lat: 34.0 + index as f64 * 0.000_001,
                lng: 108.0 + index as f64 * 0.000_001,
            })
            .collect()]
    }

    #[test]
    fn creates_lists_renames_and_deletes_bookmarks() {
        let temp = TempDir::new().unwrap();
        let store = RegionBookmarkStore::open_at(temp.path()).unwrap();
        let created = store
            .create(" 永寿县 ".to_string(), bounds(), Some(polygon(4)))
            .unwrap();

        assert_eq!(created.name, "永寿县");
        assert_eq!(store.list().unwrap(), vec![created.clone()]);

        let renamed = store.rename(&created.id, "永寿县北部".to_string()).unwrap();
        assert_eq!(renamed.name, "永寿县北部");

        store.delete(&created.id).unwrap();
        assert!(store.list().unwrap().is_empty());
    }

    #[test]
    fn persists_large_imported_boundaries_across_reopen() {
        let temp = TempDir::new().unwrap();
        let created = RegionBookmarkStore::open_at(temp.path())
            .unwrap()
            .create("大型 KML".to_string(), bounds(), Some(polygon(15_000)))
            .unwrap();

        let reopened = RegionBookmarkStore::open_at(temp.path()).unwrap();
        let restored = reopened.list().unwrap().pop().unwrap();
        assert_eq!(restored.id, created.id);
        assert_eq!(restored.polygon.unwrap()[0].len(), 15_000);
    }

    #[test]
    fn rejects_blank_and_oversized_names() {
        let temp = TempDir::new().unwrap();
        let store = RegionBookmarkStore::open_at(temp.path()).unwrap();
        assert!(store.create("  ".to_string(), bounds(), None).is_err());
        assert!(store
            .create("a".repeat(MAX_NAME_CHARS + 1), bounds(), None)
            .is_err());
    }
}
