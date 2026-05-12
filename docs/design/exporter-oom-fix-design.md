# Exporter OOM 修复设计 (C3/C4)

> **状态**: Draft
> **关联**: 安全审计 C3/C4
> **目标版本**: v3.3.0
> **优先级**: Critical

---

## 一、背景

代码安全审计发现 `exporter` + `merger` 在大区域下载时存在严重 OOM 风险。当前 `max_tiles` 上限 `500_000`，理论最大画布占用 **~98 GB** RGB 内存，远超普通用户机器容量。即便在 50,000 瓦片的常用上限下，仍需 ~10 GB 内存。

历史背景：v3.2.x 已为 GeoTIFF 实现 `streaming_tiff`（流式 strip 写入），但仅在 **瓦片数 > 5000 且无多边形裁剪** 时启用。PNG/JPEG/裁剪 GeoTIFF 全部走全量内存路径。

---

## 二、问题盘点

### 完整数据流

```
TileDownloader → temp_dir 中 N 个瓦片 PNG（仅持路径，不持像素）
       │
       ├─ A. 流式路径（GeoTIFF + 瓦片>5000 + 无裁剪）
       │    streaming_tiff: 逐 strip 读 → 压缩 → 写盘
       │    峰值内存: ~strip + compressed_strip ≈ 几百 MB
       │
       └─ B. 全量内存路径（PNG/JPEG/小 GeoTIFF/带裁剪）
            merger: RgbImage::from_pixel(W*256, H*256)  ← 一次性大分配
            (可选) mask_image_by_polygons: 同时持 RGB + RGBA
            exporter: write_to(Cursor<Vec>)  ← 编码再持一份
            commands.rs: fs::write(&bytes)
```

### 风险点（按严重度）

| ID | 位置 | 模式 | 50k 瓦片峰值 | 触发 |
|----|------|------|-------------|------|
| **R1** 致命 | [merger.rs#L30](../src-tauri/src/merger.rs#L30) | `RgbImage::from_pixel(W,H)` 全量画布 | ~9.9 GB | PNG/JPEG/小 TIFF/裁剪 TIFF |
| **R2** 高 | [merger.rs#L108](../src-tauri/src/merger.rs#L108) | RGB + RGBA 双倍驻留 | ~23.1 GB | crop_to_shape + 多边形 |
| **R3** 高 | [exporter.rs#L62](../src-tauri/src/exporter.rs#L62) | `image.clone()` + 编码缓冲 | ~28-31 GB | 多边形裁剪 + PNG/JPEG |
| **R4** 中 | [commands.rs#L575](../src-tauri/src/commands.rs#L575) | 画布 + 编码字节同时驻留 | ~19.8 GB | 大 + 无压缩 TIFF + 非流式 |
| **R5** 低 | [streaming_tiff.rs#L110](../src-tauri/src/streaming_tiff.rs#L110) | strip + compressed 同时持 | ~290 MB | 流式 GeoTIFF（可控）|
| **R6** 设计 | [commands.rs#L134](../src-tauri/src/commands.rs#L134) | `max_tiles=500_000` 仅校验数量 | 理论 98 GB | 上限设计缺陷 |

> 完整尺寸表：5k → 0.99 GB / 50k → 9.9 GB / 100k → 19.6 GB / 500k → 98 GB。

---

## 三、改造方案

### 总体策略：**流式优先 + 内存预算 + 必要时分块**

按以下优先级递进改造，每阶段独立可上线：

#### 阶段 1：内存预算守卫（v3.3.0-A，1 天）

**目标**：从源头止血，禁止内存超出预算的导出请求。

- 引入 `MemoryBudget`：默认 2 GB，可在设置中调整（512 MB - 16 GB）
- 在 `commands.rs::estimate_download` 与 `execute_task` 入口计算预估内存：
  ```rust
  let pixel_bytes = (cols as u64) * (rows as u64) * 256 * 256 * channels;
  let estimated_peak = pixel_bytes * peak_multiplier(format, has_crop);
  ```
- `peak_multiplier`：
  | 格式 | 无裁剪 | 有裁剪 |
  |------|--------|--------|
  | 流式 TIFF | 0.05 | n/a |
  | 全量 TIFF | 2.0 | 3.5 |
  | PNG/JPEG | 2.5 | 5.0 |
- 超预算返回友好错误 + 建议：
  - "请缩小区域至约 X 瓦片"
  - "请改用 GeoTIFF（流式）"
  - "请关闭多边形裁剪"
  - "请在设置中提升内存预算（当前 2 GB）"

#### 阶段 2：扩大流式路径覆盖（v3.3.0-B，2 天）

**目标**：消灭 R4，部分缓解 R1。

- **去掉 `tile_count > 5000` 门槛**：基于内存预算自动决策，小图也可走流式
- **GeoTIFF + 多边形裁剪走流式**：在 `streaming_tiff` 中集成扫描线掩码
  - 实现思路：每写一行 strip 前，根据多边形掩码逐像素 zero-out
  - 复用现有 `mask_image_by_polygons` 的 GeoJSON → 像素坐标转换逻辑
- **直接写 `BufWriter<File>`**：消除 `Cursor<Vec<u8>>` 中间缓冲

#### 阶段 3：PNG/JPEG 流式编码（v3.3.0-C，2 天）

**目标**：消灭 R1（PNG/JPEG 路径）。

- **PNG**：使用 `png` crate 的 `StreamWriter`：
  ```rust
  let mut encoder = png::Encoder::new(BufWriter::new(file), w, h);
  let mut writer = encoder.write_header()?.into_stream_writer()?;
  for strip in strips { writer.write_all(&strip)?; }
  ```
- **JPEG**：使用 `jpeg-encoder` 的 scanline API（或 `mozjpeg` 如可接受 C 依赖）
- 复用阶段 2 的 strip 生成器，三种格式共享流式核心

#### 阶段 4：裁剪原地转换（v3.3.0-D，1 天）

**目标**：消灭 R2/R3 的双倍驻留。

- `mask_image_by_polygons` 改为消费式 API（接收 `RgbImage` 而非引用）
- 内部直接生成 RGBA Vec，drop 原 RGB
- 编码侧：`export_rgba_png_bytes` 不再 `clone`，直接用 `png::Encoder` 写 raw

---

## 四、Rust 接口设计草案

```rust
// src-tauri/src/exporter/streaming.rs (新增)
pub struct StreamingExporter<W: Write> {
    writer: W,
    width: u32,
    height: u32,
    format: ExportFormat,
    bounds: Option<TileBounds>,
    polygon_mask: Option<PolygonMask>,
}

impl<W: Write> StreamingExporter<W> {
    pub fn new(writer: W, opts: ExportOptions) -> Result<Self, String>;
    pub fn write_strip(&mut self, row_idx: u32, pixels: &[u8]) -> Result<(), String>;
    pub fn finish(self) -> Result<(), String>;
}

// src-tauri/src/exporter/budget.rs (新增)
pub struct MemoryBudget(u64);
impl MemoryBudget {
    pub fn from_settings(s: &Settings) -> Self;
    pub fn check(&self, estimated: u64) -> Result<(), BudgetError>;
}

pub enum BudgetError {
    Exceeded { estimated: u64, budget: u64, suggestions: Vec<String> },
}
```

---

## 五、实施计划

| 里程碑 | 工作量 | 交付物 | 验收 |
|--------|--------|--------|------|
| **M1** 内存预算守卫 | 1 天 | `budget.rs` + commands 入口校验 + 设置项 | 超预算请求返回友好错误，单测覆盖估算 |
| **M2** 流式路径扩展 | 2 天 | streaming_tiff 支持任意 tile_count + 裁剪 | E2E：50k 瓦片 + 多边形 + GeoTIFF 内存峰值 < 1 GB |
| **M3** PNG/JPEG 流式 | 2 天 | streaming PNG/JPEG encoder | E2E：50k 瓦片 PNG 内存峰值 < 1 GB |
| **M4** 原地裁剪 | 1 天 | 消除 clone，RGB→RGBA 原地扩展 | 多边形裁剪场景内存峰值减半 |
| **M5** 合成性能优化 | 1 天 | rayon 并行解码 + 双缓冲流水线 | 50k 瓦片合成耗时降低 5-7× |

**总计**：~7 个工作日，可拆为 5 个独立 PR。

---

## 六、测试计划

### 单元测试

- `budget::peak_multiplier` 各格式 × 是否裁剪 = 8 组用例
- `budget::check` 边界条件（恰好等于预算 / 超出 1 字节）
- `streaming::write_strip` 行号越界、pixels 长度不匹配

### 集成测试（内存峰值监控）

| 场景 | 瓦片数 | 格式 | 裁剪 | 内存预算 | 期望峰值 |
|------|--------|------|------|----------|----------|
| 小图基准 | 100 | PNG | 否 | 2 GB | < 100 MB |
| 大图流式 TIFF | 50,000 | GeoTIFF | 否 | 2 GB | < 500 MB |
| 大图流式 PNG | 50,000 | PNG | 否 | 2 GB | < 500 MB |
| 裁剪流式 TIFF | 50,000 | GeoTIFF | 是 | 2 GB | < 800 MB |
| 超预算拒绝 | 200,000 | PNG | 否 | 2 GB | 早返回错误 |

### 兼容性

- 现有任务恢复：v3.2.x 已下载的瓦片缓存 → v3.3.0 续传/导出能正常工作
- 设置迁移：旧版本无 `memory_budget` 字段时自动填默认 2 GB

---

## 七、风险评估

| 风险 | 级别 | 缓解 |
|------|------|------|
| 流式 PNG 编码 crate 兼容性差异 | 中 | 先评估 `png` crate StreamWriter 在大尺寸下的行为，必要时 fallback `image` crate |
| 流式裁剪掩码精度 | 低 | 沿用现有像素坐标计算，仅改写循环结构，结果应严格一致（加单测对比）|
| 内存预算误判（保守过头）| 中 | `peak_multiplier` 暴露在设置中可调，提供"测试模式"打印实际峰值 |
| 用户感知"任务变慢" | 低 | 流式实际更快（无大块分配），但需基准测试佐证 |

---

## 八、向后兼容

- `commands.rs::execute_task` 签名不变，仅内部决策逻辑切换
- 新增设置项 `memory_budget_mb`（默认 2048）+ `enable_strict_memory_check`（默认 true）
- 旧版本配置文件无新字段时自动填默认值，无破坏性变更

---

## 九、决策记录

- **不引入 GDAL 依赖做导出**：保持轻量；GDAL 仅用于读取（已有 feature flag）
- **不实现"自动分块导出多文件"**：避免破坏用户预期的单文件输出，超预算直接报错让用户调整
- **不将 max_tiles 降低**：max_tiles 是 UI 层提示，真正的守门员是内存预算
- **流式裁剪暂不支持非凸多边形优化**：先正确性优先，性能优化后续 RFC
- **不引入 spng FFI 做 PNG 加速解码**：Rust 绑定 5 年无人维护（v0.1.0），C 依赖引入构建复杂度 + 安全面；纯 Rust 的 `zune-png` 可达相当性能（2-4×），但 PNG 瓦片源占比有限，优先级低于 rayon 并行（全格式通吃）
- **不引入 turbojpeg FFI 做 JPEG 加速解码**：同理 C 依赖成本高；rayon 并行解码已覆盖 JPEG 瓦片源加速需求
- **合成性能优先做 rayon 并行而非单线程解码器替换**：并行解码 4-6× 加速是全格式通吃的杠杆，而 zune-png/turbojpeg 各自仅覆盖单一输入格式

---

## 十、参考

- 内存峰值实测数据来源：调研报告（详见 commit message）
- `streaming_tiff.rs` 当前实现：v3.2.x 主干
- `png` crate StreamWriter：https://docs.rs/png/latest/png/struct.StreamWriter.html
- `jpeg-encoder` crate：https://docs.rs/jpeg-encoder/

---

## 附录：合成性能优化方案（M5）

### 现状瓶颈

合成阶段（瓦片解码 → strip 填充 → 编码写盘）中，**解码占 50-70% 耗时**，当前完全单线程。

典型输入：JPEG 瓦片（卫星影像）> PNG 瓦片（标注图/DEM）。

### M5.1 rayon strip 内并行解码（P0，0.5 天）

```rust
use rayon::prelude::*;

let decoded: Vec<RgbImage> = (0..cols).into_par_iter()
    .map(|col| {
        let path = tile_paths.get(&(col, row))?;
        let bytes = fs::read(path)?;
        image::load_from_memory(&bytes)?.to_rgb8()
    })
    .collect::<Result<_>>()?;

// 串行填入 strip（避免 cache line 抖动）
for (col, tile) in decoded.iter().enumerate() {
    fill_strip(&mut strip, col, tile);
}
```

预期加速：8 核机器 **4-6×**（解码 60% × 6× ≈ 3.6-4.2× 总加速）。

### M5.2 双缓冲流水线（P1，0.5 天）

```
strip[0] 在 CPU 解码 + 填充    ←─ 并行
strip[1] 已填好，在压缩 + 写盘  ←─ 并行
```

预期加速：在 M5.1 基础上再 1.3-1.5×。

### 后续评估项（v3.4，不在 v3.3 范围）

| 方案 | 加速 | 适用 | 成本 |
|------|------|------|------|
| 升级 `image` crate（含 fdeflate）| 1.5× | PNG 输入 | 0.2d |
| `zune-png` 纯 Rust PNG 解码器 | 2-4× | PNG 输入 | 1d + 基准测试 |
| `turbojpeg` FFI | 2-4× | JPEG 输入 | 1.5d + C 依赖 |
| GPU 解码 | 10× | 旗舰场景 | 高复杂度 |
