# 3D Tiles 下载功能 — 技术设计文档

> 创建日期: 2026-04-04
> 状态: 方案设计阶段

## 1. 功能概述

在现有 GeoDownloader 基础上，新增 **3D Tiles（倾斜摄影模型）按区域下载**能力。用户在地图上绘制区域，系统自动过滤并下载该区域内的 3D Tiles 数据，输出可离线加载的完整 tileset 目录。

### 核心需求

- 支持按矩形/多边形区域裁剪下载
- 支持 Cesium Ion 和自定义 URL 两种数据源
- 输出离线可用的 tileset 目录（拖入 Cesium Viewer 即可加载）
- 与现有 TIF 下载功能共存于同一应用，通过模式切换访问

---

## 2. 技术方案：包围体过滤

### 方案选型

| 方案 | 原理 | 精度 | 复杂度 | 选定 |
|------|------|------|--------|------|
| **A. 包围体过滤** | 按瓦片 boundingVolume 与选区的空间相交关系过滤 | 边缘略有溢出 | 中 | ✅ |
| B. 几何裁切 | 对边缘瓦片做三角网裁切 | 精确 | 极高 | ✗ |
| C. 外部工具链 | 调用 3d-tiles-tools | 受限 | 低 | ✗ |

**选定方案 A**：90% 实用价值，10% 复杂度。边缘瓦片的微量溢出是 OSGB 网格组织的固有特性，完全可接受。

### 过滤逻辑

```
用户绘制区域 R（矩形或多边形）
  ↓
递归遍历 tileset.json 树：
  对每个节点 T：
    1. 判定 T.boundingVolume 与 R 是否相交
    2. 递归处理 T.children
    3. 决定保留或剪枝
  ↓
重写 tileset.json，仅保留已下载节点
  ↓
输出离线 tileset 目录
```

### 包围体相交判定

3D Tiles 的 boundingVolume 有三种类型：

| 类型 | 结构 | 相交判定方法 |
|------|------|------------|
| `region` | `[west, south, east, north, minH, maxH]`（弧度） | 经纬度矩形/多边形交集（最常见，最简单） |
| `box` | 12 个浮点数（中心 + 3 轴半长） | OBB-多边形相交检测 |
| `sphere` | `[cx, cy, cz, r]` | 球体-多边形相交检测 |

#### 不规则多边形支持

支持任意多边形选区，采用两级过滤：

```
第一级：多边形 MBR（最小外接矩形）快速排除
第二级：精确多边形-包围体相交判定
  ├─ 矩形任一顶点在多边形内？→ 相交
  ├─ 多边形任一顶点在矩形内？→ 相交
  ├─ 多边形任一边与矩形任一边相交？→ 相交
  └─ 以上皆否 → 不相交
```

---

## 3. 层级一致性保证

### 核心策略：保路径、剪死枝、结构节点可无内容

```
规则 1：选区内的瓦片 → 下载内容 + 保留节点
规则 2：选区外，但子孙有在选区内的 → 保留节点结构（content 置空）
规则 3：自身及所有子孙都不在选区内 → 整棵子树剪枝
```

### 示例

```
原始树：

Root (geometricError: 100)
├── A (gE: 50) ← 选区外
│   ├── A1 (gE: 10) ← 选区内 ✓
│   └── A2 (gE: 10) ← 选区外
├── B (gE: 50) ← 选区内 ✓
│   ├── B1 (gE: 10) ← 选区内 ✓
│   └── B2 (gE: 10) ← 选区内 ✓
└── C (gE: 50) ← 选区外
    └── C1, C2 ← 选区外

过滤后：

Root ← 保留（结构节点，内容可选）
├── A  ← 保留为路径节点，content 置空
│   └── A1 ← 下载 ✓
└── B  ← 下载 ✓
    ├── B1 ← 下载 ✓
    └── B2 ← 下载 ✓

C 子树 → 整体剪除
A2 → 剪除
```

### 一致性保证

| 属性 | 状态 | 说明 |
|------|------|------|
| 树结构 | ✅ | 根到叶路径完整 |
| geometricError 递减 | ✅ | 保持原值不动 |
| boundingVolume | ✅ | 保持原值（略偏大但不影响） |
| refine: REPLACE | ✅ | 替换链不断 |
| refine: ADD | ⚠️ | 中间节点无内容时远景缺粗模，属预期行为 |
| 外部 tileset 引用 | ✅ | 递归处理 |

### 伪代码

```rust
fn filter_tile(tile: &Tile, region: &Polygon) -> Option<FilteredTile> {
    let self_intersects = tile.bounding_volume.intersects(region);

    let filtered_children: Vec<_> = tile.children.iter()
        .filter_map(|child| filter_tile(child, region))
        .collect();

    if !self_intersects && filtered_children.is_empty() {
        return None;  // 规则 3
    }

    Some(FilteredTile {
        content: if self_intersects { tile.content.clone() } else { None },
        children: filtered_children,
        geometric_error: tile.geometric_error,
        bounding_volume: tile.bounding_volume.clone(),
        refine: tile.refine.clone(),
    })
}
```

---

## 4. 数据源支持

### 4.1 Cesium Ion

```
用户输入 Asset ID + Access Token
  → GET https://api.cesium.com/v1/assets/{assetId}/endpoint
  → 获取临时 tileset URL + 临时 access token
  → 下载过程中定期刷新 token（有效期约 1 小时）
```

**Token 刷新策略**：距到期 < 5 分钟时暂停新请求 → 重新 resolve → 更新 auth → 恢复。

### 4.2 自定义 URL

```
用户输入 tileset.json URL（可选自定义 Header）
  → 直接 GET → 解析 → 下载
```

### 数据模型

```rust
pub enum TilesSource {
    CesiumIon {
        asset_id: u64,
        access_token: String,
    },
    DirectUrl {
        tileset_url: String,
        headers: Option<HashMap<String, String>>,
    },
}

pub struct ResolvedEndpoint {
    pub tileset_url: String,
    pub auth: Auth,
    pub expires_at: Option<DateTime<Utc>>,
}

pub enum Auth {
    Bearer(String),
    Custom(HashMap<String, String>),
    None,
}
```

---

## 5. 3D Tiles 版本兼容

### 1.0 vs 1.1 关键差异

| 维度 | 1.0 | 1.1 |
|------|-----|-----|
| 瓦片发现 | 显式 `children` 递归 | 显式 **或** 隐式切分（implicit tiling） |
| URL 字段 | `content.url` | `content.uri` |
| 内容数量 | 单个 `content` | `contents` 数组（多个） |
| 内容格式 | `.b3dm` `.i3dm` `.pnts` `.cmpt` | `.glb`（旧格式 deprecated 但仍需支持） |
| subtree | 无 | 二进制 `.subtree` 文件（位掩码描述可用性） |

### 隐式切分（Implicit Tiling）

1.1 的隐式切分不再逐个列出瓦片，而是用模板 + 可用性位图：

```json
{
  "root": {
    "content": { "uri": "content/{level}/{x}/{y}.glb" },
    "implicitTiling": {
      "subdivisionScheme": "QUADTREE",
      "subtreeLengths": [16],
      "availableLevels": 20,
      "subtrees": {
        "uri": "subtrees/{level}/{x}/{y}.subtree"
      }
    }
  }
}
```

`.subtree` 二进制文件包含：
- `tileAvailability` — 哪些树位置存在瓦片
- `contentAvailability` — 哪些瓦片有可下载内容
- `childSubtreeAvailability` — 哪些叶节点指向子树

### 实施分期

**Phase 1**（覆盖国内大部分数据）：
- 显式树递归遍历
- 兼容 `url`/`uri`、`content`/`contents`
- 格式无关下载（.b3dm/.glb/.pnts 等直接存储）

**Phase 2**（覆盖 Google 3D Tiles、新版 Ion）：
- `.subtree` 二进制解析
- 四叉树/八叉树位置计算
- 模板 URL 展开

---

## 6. 项目架构

### 与现有代码的关系

在同一项目中实现，新增 `tiles3d/` 模块。

#### 复用分析

| 模块 | 复用度 | 说明 |
|------|--------|------|
| `task.rs` (TaskManager + PauseControl) | 75% | 直接复用，泛化 TaskStatus |
| `settings.rs` (SettingsManager) | 95% | 新增配置字段即可 |
| `commands.rs` (任务管理命令) | 100% | cancel/pause/resume/logs 零改动 |
| `downloader.rs` (HTTP 引擎) | 40% | 底层 HTTP+重试可复用，外壳需重写 |
| 前端 Leaflet.draw | 80% | 地图绘图工具直接复用 |

#### 新增模块

```
src-tauri/src/
├── commands.rs          ← 扩展：新增 3D Tiles 命令
├── downloader.rs        ← 提取通用 HTTP 下载原语
├── task.rs              ← 泛化 TaskStatus
├── settings.rs          ← 新增 3D Tiles 配置字段
├── tile.rs              ← 不动（XYZ 专用）
├── merger.rs            ← 不动（XYZ 专用）
├── exporter.rs          ← 不动（XYZ 专用）
├── streaming_tiff.rs    ← 不动（XYZ 专用）
├── tiles3d/             ← 新增模块
│   ├── mod.rs           ← 公开接口
│   ├── tileset.rs       ← tileset.json 解析与重写
│   ├── filter.rs        ← 空间过滤（包围体相交判定）
│   └── fetcher.rs       ← 树遍历 + 下载编排
```

---

## 7. 前端 UI 设计

### 模式切换

标题栏嵌入药丸形滑块：

```
┌─ 🔽 标题  [ TIF 瓦片 ⬤| 3D Tiles ]  ─ □ ✕ ─┐
```

- CSS transition 200ms 滑动动画
- 切换时左侧面板内容淡入淡出
- 地图和绘图工具保持不变
- 下载中心 Tab 不受影响（两种任务统一展示）

### 3D Tiles 模式 — 数据源面板

```
┌─────────────────────────────────┐
│  数据源  [ Cesium Ion ⬤| URL ]  │
├─────────────────────────────────┤
│ ── Cesium Ion ──                │
│  Asset ID:  [__________]        │
│  Token:     [__________]        │
│  [解析资产]                      │
├─────────────────────────────────┤
│ ── URL ──                       │
│  Tileset URL: [_____________]   │
│  ▸ 自定义请求头（可选）          │
│  [解析]                          │
└─────────────────────────────────┘
```

### 两种模式下的面板差异

| 区域 | TIF 瓦片 | 3D Tiles |
|------|----------|----------|
| 区域选择 | 共享 | 共享 |
| 数据源 | 图源下拉 | URL / Ion Asset ID |
| 精度控制 | 缩放级别 1-22 | LOD 层级 / 全部 |
| 输出格式 | GeoTIFF/PNG/JPEG | 无需（保持原始结构） |
| 裁剪/压缩 | 按边界裁剪 + LZW | 无 |
| 估算信息 | 瓦片数 × 大小 | 节点数 × 估计大小 |
| 下载按钮 | "下载地图" | "下载模型" |
| 矢量数据 | 显示 | 隐藏 |

---

## 8. 用户工作流

```
1. 标题栏切换到 3D Tiles 模式
2. 选择数据源类型（Ion 或 URL），输入信息
3. 点击"解析" → 系统获取 tileset.json，地图上显示覆盖范围
4. 在地图上绘制矩形/多边形选区
5. 系统遍历 tileset 树，按选区过滤，估算节点数/大小
6. 确认 → 并发下载，进度条显示在"下载中心"
7. 完成 → 输出离线 tileset 目录
8. 用户可将目录拖入 Cesium Viewer 加载查看
```

---

## 9. 输出物格式

```
output_directory/
├── tileset.json          ← 重写后的入口（URL 改为本地相对路径）
├── data/
│   ├── root.b3dm         ← 或 .glb
│   ├── L1_0_0.b3dm
│   ├── L1_0_1.b3dm
│   ├── L2_0_0.b3dm
│   └── ...
└── (可选) subtrees/      ← Phase 2 隐式切分的子树文件
```

- `tileset.json` 中所有远端 URL 重写为本地相对路径
- 文件名保持原始或按层级重命名（可配置）
- 目录可直接用于 Cesium Viewer / CesiumJS 离线加载
