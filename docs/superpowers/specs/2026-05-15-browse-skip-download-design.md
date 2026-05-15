# Issue #28: 浏览期间新缓存的瓦片从待下载矩阵动态剔除

## 问题

下载任务进行中，用户在地图上浏览会触发瓦片缓存写入（前端调 `cache_put_tile`）。如果某张瓦片已在下载队列中排队，会重复下载浪费带宽。

## 方案：DashSet 注册 + Store::put 时移除

### 核心机制

1. 全局 `DashSet<(String, u8, u32, u32)>` 记录"正在下载中的坐标"（source_key + z/x/y）
2. 全局 `AtomicU64` 累计"被浏览补齐"的瓦片数
3. 下载器启动时注册待下载坐标，结束时注销
4. `Store::put` 成功后检查 DashSet，命中则 remove + 计数器 +1
5. 每个 tile future 在发网络请求前检查坐标是否仍在 DashSet 中，不在则直接读缓存返回

### 新增文件

- `src-tauri/src/tile_cache/active_downloads.rs` — DashSet + 注册/注销/查询 API

### 修改文件

- `src-tauri/src/tile_cache/mod.rs` — 导出 active_downloads 模块
- `src-tauri/src/tile_cache/pool.rs` — `Store::put` 成功后检查 DashSet
- `src-tauri/src/downloader.rs` — 注册/注销 + future 内检查 + 进度增加 browse_filled
- `src-tauri/Cargo.toml` — 添加 dashmap 依赖

### 数据流

```
浏览写缓存路径:
  前端 → cache_put_tile → Store::put → 检查 DashSet → 命中 → remove + 计数器++

下载器路径:
  启动 → register_downloading(source, coords)
  每个 tile future:
    检查 DashSet.contains(coord)?
      不在 → 说明已被浏览补齐 → 读缓存返回
      在 → 正常下载
  结束 → unregister_downloading(source)
```

### 进度结构变更

`DownloadProgress` 增加 `browse_filled: u32` 字段，前端可展示"浏览补齐 X 张，节省下载 X 张"。

### 安全性

- DashSet 是 lock-free 并发结构，不会死锁
- `Store::put` 中只做 `remove`（O(1)），不影响写入性能
- 下载器 `unregister` 确保任务结束后不会残留坐标
- 即使 DashSet 检查和缓存读取之间有微小竞态（极端情况下缓存还没写完），tile future 内已有的缓存查询会 fallback 到正常下载，不会丢数据
