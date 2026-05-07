# 2026-05-07 Wayback 缩放级别 UI 升级为任意级别多选

## 背景

用户反馈：Wayback 页的"缩放级别 + 最大缩放"两个数字输入与普通影像页（imagery-page）的"任意级别 chip 多选"差异明显，使用体验不统一。

排查发现后端 [`src-tauri/src/commands.rs:958`](../../src-tauri/src/commands.rs) 的下载循环早就支持 `zoom_levels` 离散多选：

```rust
let zooms = if let Some(levels) = request.zoom_levels.as_ref().filter(|l| !l.is_empty()) {
    // 任意级别多选优先
    ...
} else {
    (z_min..=z_max).collect()
};
```

普通影像页走的是离散多选分支，Wayback 页一直走 `(z_min..=z_max)` 区间分支。差异是前端历史欠债，不是功能限制。

## 改动

### 后端

[`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs)

`WaybackIncrementalRequest` 新增 `zoom_levels: Option<Vec<u8>>` 字段，并在内部构造 `DownloadRequest` 时传入：

```rust
pub struct WaybackIncrementalRequest {
    ...
    #[serde(default)]
    pub zoom_max: Option<u8>,
    /// 任意级别多选（Wayback 前端 chip 多选）；非空时优先于 zoom..=zoom_max
    #[serde(default)]
    pub zoom_levels: Option<Vec<u8>>,
    ...
}
```

`download_wayback_incremental` 内部把 `req.zoom_levels.clone()` 透传给 `DownloadRequest.zoom_levels`，下载循环自动走离散多选分支。

### 前端

#### 类型层

[`frontend/src/types/api.ts`](../../frontend/src/types/api.ts) `WaybackIncrementalRequest` 接口加 `zoom_levels?: Nullable<number[]>`。

#### Wayback 页面 [`frontend/src/features/wayback/wayback-page.tsx`](../../frontend/src/features/wayback/wayback-page.tsx)

1. **状态简化**：`zoom + zoomMax` 两个 state 合并为单一 `zoomLevels: number[]`（默认 `[13]`）。
2. **派生量**：`sortedLevels`（去重升序）→ `zoom`（最小级）/ `zMaxLevel`（最大级）/ `zMaxValue`（>zoom 时取 zMaxLevel，否则 null）/ `zLevelsForApi`（直接传给后端）。
3. **`formatZoomLabel` 重写**：单级 → `z13`；连续区间 → `z11-16`；离散 → `z10-15-18`（中划线分隔，文件名安全）。
4. **UI 替换**：去掉 Slider + 数字 Input，改成 22 个 chip 按钮（grid-cols-11）+ 三个区间快捷按钮（z10-14 / z14-18 / z15-19）+ 重置按钮 + 探测按钮。所有按钮和提示风格与 imagery-page 完全对齐。
5. **三处下载提交**（单版本 / 批量 / 增量）以及估算调用都补传 `zoom_levels: zLevelsForApi`，后端会优先按离散多选分级下载。
6. **probe 探测**：成功时 `setZoomLevels([z])`，从单级开始。
7. **删掉未使用的 Slider import**。

## 验证

- `tsc -b && vite build`：通过
- `cargo check`：通过

## 影响面

- 后端：`WaybackIncrementalRequest` 新增可选字段，旧请求兼容（`#[serde(default)]`）
- 前端：仅 `wayback-page.tsx` UI 变更 + `WaybackIncrementalRequest` 类型新增字段
- 下载流水线、增量扫描、批量任务、历史记录、文件命名约定均不受影响
- 离散多选会按 `z<N>/` 子目录保存（沿用 [`zoom_level_save_path`](../../src-tauri/src/commands.rs) 既有逻辑）

## 待办

未自动 commit / push，等待用户明确指示。
