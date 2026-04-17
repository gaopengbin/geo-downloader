# TIFF 金字塔（Overview Layers）功能 — 技术设计文档

> 创建日期: 2026-04-17
> 状态: 方案设计阶段
> 作者: Geo Downloader 团队
> 关联：v3.3.x 候选特性
> 社区贡献者：鳕鱼堡（表态可提供代码）

## 1. 功能概述

在 GeoTIFF / BigTIFF 导出时，可选地生成**内置影像金字塔（Overview Layers）**，大幅提升 GIS 软件浏览大图的性能。

### 用户真实反馈

> 鳕鱼堡：有一个小的建议，如果方便的话，在保存拼接后影像时，可以加一个建金字塔的选项，后续浏览数据方便一些，如需要我可以提供代码。

### 实际价值

| 场景 | 无金字塔 | 有金字塔 |
|---|---|---|
| QGIS 打开 3 GB BigTIFF 并缩小至全图 | 10-30 秒白屏 | 即时显示 |
| 平移 / 缩放 | 每次重新解码大块 | 按层级读取，几乎即时 |
| 专业 GIS 标准做法 | 不符合规范 | 符合 COG / GeoTIFF 最佳实践 |

对于项目常见的 z19+ 大文件（GB 级），金字塔不是锦上添花而是刚需。

---

## 2. 技术调研

### 2.1 TIFF 金字塔的标准实现

根据 TIFF 6.0 规范 + GeoTIFF 1.0 实践，金字塔以 **Reduced-Resolution Subfile** 形式存储：

```
┌─────────────────────────────────────┐
│ TIFF Header                         │
├─────────────────────────────────────┤
│ IFD 0 (原图) → NewSubfileType=0     │
│   StripOffsets: [..]                │
│   NextIFDOffset: → IFD 1            │
├─────────────────────────────────────┤
│ Strip Data (原图)                    │
├─────────────────────────────────────┤
│ IFD 1 (1/2 降采样) → NewSubfileType=1│
│   StripOffsets: [..]                │
│   NextIFDOffset: → IFD 2            │
├─────────────────────────────────────┤
│ Strip Data (1/2)                    │
├─────────────────────────────────────┤
│ IFD 2 (1/4) ... 以此类推             │
└─────────────────────────────────────┘
```

- **NewSubfileType (tag 254)**：LONG，bit 0 = 1 表示"reduced-resolution version"
- **IFD 按尺寸递减排列**
- GDAL `gdaladdo` 默认生成 2, 4, 8, 16 四级；COG 规范建议 2, 4, 8, ..., 到 `max(width, height) / 256 ≤ 1`

### 2.2 Overview 层数计算

```
level_count = ceil(log2(max(width, height) / 512))
```

示例：
- 10000 × 10000 → 5 层（1/2 → 5000, 1/4 → 2500, 1/8 → 1250, 1/16 → 625, 1/32 → 312）
- 65536 × 65536（z18 大图） → 7 层
- 262144 × 262144（z20 超大） → 9 层

### 2.3 降采样算法选择

| 算法 | 速度 | 质量 | 适用 |
|---|---|---|---|
| Nearest Neighbor | 最快 | 锯齿明显 | 分类数据 |
| **Box Average（默认）** | **快** | **适合卫星影像** | **推荐** |
| Bilinear | 中 | 平滑 | 可选 |
| Cubic | 慢 | 锐利 | 高要求 |
| Gauss | 最慢 | 最平滑 | 降噪 |

默认选 Box Average（对应 GDAL `-r average`），与现有 Esri/ArcGIS Pro 默认一致。后续可扩展算法选择。

### 2.4 与压缩的交互

Overview 层必须压缩：
- 不压缩：overviews 总占原图 ~33%（几何级数和）
- LZW/Deflate 压缩：~5-10%（低分辨率同质化严重，压缩率极高）

**用户在 UI 选定的压缩算法自动应用到所有层**，无需单独选择。

### 2.5 实现方案对比

| 方案 | 优点 | 缺点 | 选择 |
|---|---|---|---|
| 调用外部 gdaladdo | 算法成熟 | Tauri 打包依赖 GDAL 环境，Windows 无 GDAL 系统级二进制 | ✗ |
| gdal Rust crate | 稳定 | 构建复杂，需 GDAL C 库，增加分发体积 20+ MB | ✗ |
| **Rust 原生实现** | **自包含、零依赖、可控** | 需扩展 streaming_tiff 支持多 IFD，工作量中等 | ✅ |
| 放弃，让用户用 QGIS/gdaladdo 后处理 | 0 改动 | 违背"一站式"定位，门槛高 | ✗ |

---

## 3. 技术方案

### 3.1 总体流程

```
┌─────────────────────────────────────────────────────────┐
│ 用户导出 TIFF 时勾选 [构建金字塔]                       │
├─────────────────────────────────────────────────────────┤
│ 原图写入完成（现有流程）                                │
│   BigTIFF: streaming_tiff.rs                            │
│   常规 TIFF: exporter.rs                                │
├─────────────────────────────────────────────────────────┤
│ 【新增】金字塔生成阶段                                  │
│   1. 计算需要的层数（基于图像尺寸）                     │
│   2. 从已写入的原图读取数据（分块 strip）               │
│   3. 对每层：                                           │
│      a. 2x box average 降采样                           │
│      b. 按原压缩算法压缩                                │
│      c. 作为新 IFD 追加到文件末尾                       │
│      d. 更新前一个 IFD 的 NextIFDOffset                 │
│   4. 最后一个 IFD 的 NextIFDOffset = 0                  │
├─────────────────────────────────────────────────────────┤
│ 用户进度反馈                                            │
│   "导出完成 → 构建金字塔 1/6 → 2/6 → ... → 完成"        │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Rust 模块设计

新增文件：`src-tauri/src/pyramid.rs`（约 350 行）

```rust
//! TIFF 内置金字塔（Overview Layers）生成
//!
//! 在已导出的 GeoTIFF / BigTIFF 文件末尾追加 Reduced-Resolution IFD，
//! 提升 GIS 软件浏览性能。

use std::path::Path;

pub struct PyramidOptions {
    pub resampling: Resampling,    // 默认 BoxAverage
    pub compression: Compression,  // 与原图一致
    pub min_size: u32,             // 最小层尺寸（默认 512）
    pub progress_cb: Option<Box<dyn Fn(usize, usize) + Send + Sync>>,
}

#[derive(Clone, Copy)]
pub enum Resampling {
    Nearest,
    BoxAverage,
    Bilinear,
}

pub enum PyramidError {
    IoError(std::io::Error),
    ParseError(String),
    UnsupportedFormat,
}

/// 对已存在的 TIFF 文件追加金字塔
///
/// - `path`: 已导出的 .tif 文件路径
/// - `opts`: 生成选项
///
/// # 实现要点
/// - 打开文件做 read + write
/// - 读取现有 IFD 0，计算尺寸
/// - 依次生成各级 overview
/// - 修改 IFD 0 的 NextIFDOffset 指向新 IFD
pub fn build_pyramid<P: AsRef<Path>>(
    path: P,
    opts: PyramidOptions,
) -> Result<PyramidStats, PyramidError> {
    // 1. 打开文件，解析 header + IFD 0
    // 2. 计算 level_count
    // 3. for each level:
    //    - downsample to tmp buffer
    //    - compress
    //    - append as new IFD
    // 4. 更新链表
    // ...
}

pub struct PyramidStats {
    pub levels_generated: usize,
    pub size_added_bytes: u64,
    pub elapsed_ms: u64,
}
```

### 3.3 BigTIFF 特殊处理

现有 `streaming_tiff.rs` 写入单 IFD，需扩展支持追加：

- 文件末尾预留 8 字节 NextIFDOffset（原先写 0，改为可更新）
- `append_reduced_ifd(writer, width, height, strips, ...)` 函数
- 重新定位到原 IFD 0 的 NextIFDOffset 字段，写入新 IFD 的起始偏移

### 3.4 常规 TIFF 处理

现有 `exporter.rs` 使用 `tiff` crate。调研发现：
- `tiff` crate 0.9 的 `TiffEncoder` 支持 `next_image()` 方法写入多 IFD
- 但对**已关闭的文件再追加**不支持
- 方案：导出时如果勾选金字塔，改为**一次性在内存中完成所有 IFD**，或使用文件 append 模式手动写

优选 **先原图导出 → 关闭 → 重新打开追加**，统一走 `pyramid.rs` 模块，避免修改 `exporter.rs`。

### 3.5 降采样实现

```rust
fn box_average_2x<P: Pixel>(src: &ImageBuffer<P>) -> ImageBuffer<P> {
    let new_w = src.width() / 2;
    let new_h = src.height() / 2;
    let mut dst = ImageBuffer::new(new_w, new_h);
    for y in 0..new_h {
        for x in 0..new_w {
            // 2x2 平均（对边缘做边界检查）
            let p1 = src.get_pixel(x * 2, y * 2);
            let p2 = src.get_pixel(x * 2 + 1, y * 2);
            let p3 = src.get_pixel(x * 2, y * 2 + 1);
            let p4 = src.get_pixel(x * 2 + 1, y * 2 + 1);
            dst.put_pixel(x, y, average_4(p1, p2, p3, p4));
        }
    }
    dst
}
```

直接使用 `image` crate 的 `resize` 也可：
```rust
img.resize_exact(new_w, new_h, FilterType::Triangle)
```

### 3.6 内存管理

对超大图（z20+ 单层 65k × 65k = 12 GB RGBA）：
- **不能一次性 load 全图做降采样**
- 分块处理：2x2 strip 配对读取，每次只保留一对在内存
- 写入 strip 到临时缓冲，生成完一整层后再写 IFD

BigTIFF 的 strip 已天然按行切分，每 strip 256 行。下采样时：
- 读 2 个相邻 strip（512 行原图）→ 下采样到 256 行 → 写入 level 1 的 1 个 strip
- 内存峰值仅两个 strip（~256 MB 对于 65k 宽），远低于全图

---

## 4. UI 设计

### 4.1 新增选项

在导出设置面板（现有压缩选项旁）：

```
[文件格式]     GeoTIFF ▼
[压缩]         Deflate ▼
[构建金字塔]   ☑ 是
  ├─ 层级     自动（5 级） ▼
  ├─ 算法     Box Average ▼（默认，推荐）
  └─ ⚠️ 会增加约 10% 文件体积和 30% 导出时间
```

### 4.2 进度反馈

在现有任务卡片的"导出"阶段后增加"构建金字塔"阶段：

```
任务状态：
  ✓ 下载瓦片 8762/8762
  ✓ 合并拼接
  ✓ 导出 TIFF
  ⏳ 构建金字塔 3/5  ← 新阶段
       Level 1: 完成
       Level 2: 完成
       Level 3: 进行中 60%
  ...
```

### 4.3 默认值

- **默认勾选**（对 >500 MB 的预估文件）
- **不默认勾选**（对 <500 MB 文件，金字塔收益不明显）
- 用户可在设置面板调全局默认

---

## 5. 模块划分

### 5.1 新增文件

```
src-tauri/src/
  pyramid.rs                 # 金字塔生成核心（~350 行）
```

### 5.2 修改文件

| 文件 | 改动 | 行数 |
|---|---|---|
| `src-tauri/src/commands.rs` | `DownloadRequest` 新增字段 `build_pyramid: bool`，导出完成后调用 `pyramid::build_pyramid` | +30 |
| `src-tauri/src/lib.rs` | 注册新模块 | +1 |
| `src-tauri/Cargo.toml` | 可能增加 image crate 的 filter feature（若不用自写降采样） | +1 |
| `static/index.html` | 导出选项增加 checkbox | +10 |
| `static/js/app.js` | 读取 checkbox 传给后端 | +20 |
| `static/js/api.js` | `DownloadRequest` 类型扩展 | +5 |

**总计**：新增 350 + 修改 67 ≈ 420 行

---

## 6. 实施计划

### 6.1 里程碑

| 阶段 | 内容 | 工期 |
|---|---|---|
| **M1** | `pyramid.rs` 骨架 + 读原 TIFF → 解析 IFD 0 | 0.5 天 |
| **M2** | 2x box average 降采样 + strip 分块处理 | 0.5 天 |
| **M3** | 追加 IFD 到 BigTIFF 文件末尾 + IFD 链表维护 | 0.5 天 |
| **M4** | 常规 TIFF 路径支持 + 压缩 strip | 0.25 天 |
| **M5** | 前端 UI + 进度事件 | 0.25 天 |
| **测试** | 5 种典型尺寸（500MB / 1GB / 3GB / 10GB）QGIS 验证 | 0.5 天 |
| **总计** | | **~2.5 天** |

### 6.2 验证清单

- ✅ QGIS 打开带金字塔的 3GB 文件，全图缩放流畅（目标 < 1s）
- ✅ ArcGIS Pro 能识别并使用 overview
- ✅ gdalinfo 能列出所有 overview 层
- ✅ 原图像素内容无改变（与未加金字塔的文件 diff 前 X 字节一致）
- ✅ 金字塔生成过程中用户取消 → 原文件保持可用（未损坏）

### 6.3 发布策略

- 作为 **v3.3.0** 主要特性
- 与批量 shp 下载同 release

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| IFD 追加过程崩溃导致文件损坏 | 中 | 高 | 生成金字塔前先备份 `.tmp` 文件；成功后替换原文件 |
| 用户取消中断 | 高 | 中 | 同上 + 取消时删除临时文件，保留原图 |
| 压缩后 strip 对齐问题 | 中 | 中 | 对齐到 2 字节边界（与审查报告中 BigTIFF H6 一致） |
| image crate 降采样精度不足 | 低 | 低 | 自写 box average 保证像素精确 |
| 前端在后端构建金字塔时 UI 卡顿 | 低 | 低 | 走 spawn_blocking，通过 progress 事件通知 |
| 非 Web Mercator 投影的金字塔需特殊处理 | 低 | 低 | 当前仅支持 EPSG:3857，后续扩展 |

---

## 8. 非目标

- ❌ 不实现外部 `.ovr` 文件（仅内置金字塔）
- ❌ 不支持 JPEG 压缩金字塔层（对彩色卫星有损，违背科研需求）
- ❌ 不实现自适应算法选择（仅 Box Average + Bilinear）
- ❌ 不对已有文件追加金字塔（仅在导出时生成；独立工具后续考虑）

---

## 9. 后续演进

### 9.1 独立金字塔工具（v3.4+）

新增 Tauri command `build_pyramid_for_existing_file`：
- 用户选择已有 TIFF
- 复用 `pyramid.rs` 模块
- 独立菜单入口：工具 → 为影像构建金字塔

### 9.2 COG 模式（v3.4+）

Cloud-Optimized GeoTIFF 规范：
- 金字塔优先存储（小层在前）
- Tiled 而非 Stripped
- 适合网络流式访问

当前方案是 Classic Overview Order（大层在前），可选模式切换为 COG Order。

### 9.3 接受社区 PR

鳕鱼堡表态可提供代码。收到 PR 后：
- 作为参考实现或直接合入（视代码质量和架构契合度）
- 贡献者列表公开致谢

---

## 10. 附录

### 10.1 用户需求时间线

- **2026-04-17 22:xx** — 鳕鱼堡在 QQ 群提出"保存拼接后影像可加建金字塔选项"
- **2026-04-17 23:xx** — 本文档落地

### 10.2 参考资料

- TIFF 6.0 Specification: https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf
- GeoTIFF 1.1 Standard: https://docs.ogc.org/is/19-008r4/19-008r4.html
- Cloud Optimized GeoTIFF: https://www.cogeo.org/
- GDAL `gdaladdo`: https://gdal.org/programs/gdaladdo.html
- libtiff subfile 说明: https://www.remotesensing.org/libtiff/libtiff.html

### 10.3 相关模块

- [src-tauri/src/streaming_tiff.rs](../src-tauri/src/streaming_tiff.rs) — BigTIFF 写入器（需扩展）
- [src-tauri/src/exporter.rs](../src-tauri/src/exporter.rs) — 常规 TIFF 导出（需集成调用）
- [src-tauri/src/commands.rs](../src-tauri/src/commands.rs) — Tauri 命令入口

---

## 11. 性能预估

基于审查报告中实测数据（z21 亚马逊 3.29 GB BigTIFF，Deflate 压缩）：

| 指标 | 数值 |
|---|---|
| 原图导出耗时 | ~12 分钟 |
| 金字塔生成耗时 | ~3-4 分钟（+25-33%） |
| 金字塔追加体积 | ~200-300 MB（+6-9%） |
| 总文件体积 | ~3.5-3.6 GB |
| QGIS 打开全图缩放 | **从 15 秒 → 0.5 秒** |

对于 z19 以下小文件（<500 MB）：
- 生成耗时 < 30 秒
- 追加体积 < 10 MB
- 收益仍明显（QGIS 从 3 秒 → 即时）
