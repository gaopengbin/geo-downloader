# 批量 Shapefile 下载功能 — 技术设计文档

> 创建日期: 2026-04-17
> 状态: 方案设计阶段
> 作者: Geo Downloader 团队
> 关联：v3.3.x 候选特性

## 1. 功能概述

支持用户导入含**多个要素（Feature）** 的 Shapefile / GeoJSON，按**每个 feature 独立生成一个 TIFF 文件**，而非合并为单个外接矩形。

### 用户真实反馈

> 杨明旺：佬，能不能加一个批量根据 shp 来下载，我有好多个小格网需要下载。
>
> 杨明旺：我现在是一个 shp 中多个格网要素，但是下载出来是一整个外接矩形。
>
> jojo：之前下个瓦片、导个影像要开好几个软件，现在一个 GeoD 就搞定了。未来如果能增加批量范围内导入下载，和支持数字高程基本就完美了！

多位用户同时响应（群友👍支持），是**高频刚需**。

### 核心需求

- 单个 shp/geojson 内含 N 个 polygon feature，每个独立下载
- 从 dbf 属性字段选定命名字段（name / ID / code 等）
- 用户可勾选仅下载部分要素
- 批量任务进度汇总与 manifest 输出

---

## 2. 现状分析

### 2.1 已有能力

- **前端**：`shpjs` 解析 .shp/.dbf 得到 FeatureCollection（含 properties）
- **前端工具函数** `extractPolygonFromGeoJSON` 已支持提取多个 polygon（返回 `allRings[]`）
- **后端**：`create_download_task` 命令已完整支持 `{bounds, polygon, save_path}`

### 2.2 缺失环节

- 前端 `setBoundaryFromGeoJSON` 将多 feature 合并为总外接矩形（仅用首个 polygon 做裁剪）
- 无要素清单 UI、无命名字段选择、无批量调度

### 2.3 改造点定位

**后端零改造**——复用现有任务系统。工作量集中在前端：
- 要素清单组件
- 命名字段选择
- 批量任务调度（Promise 队列）
- 统一进度展示与 manifest 输出

---

## 3. 技术方案

### 3.1 数据流

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 用户选择 shp 文件（.shp + .shx + .dbf）                  │
│    shp.parseShp + shp.parseDbf → FeatureCollection          │
│    保留 feature.properties（dbf 属性字段值）                │
├─────────────────────────────────────────────────────────────┤
│ 2. 检测 features.length                                     │
│    - 0: 报错                                                │
│    - 1: 走原有单要素流程                                    │
│    - >1: 弹出"多要素模式选择"对话框                         │
├─────────────────────────────────────────────────────────────┤
│ 3. 多要素模式选择                                           │
│    ○ 合并为单范围（当前行为，向后兼容）                     │
│    ● 每个要素独立下载（新模式）                             │
├─────────────────────────────────────────────────────────────┤
│ 4. 独立模式：展示要素列表                                   │
│    - 从 properties 自动推荐命名字段（优先 name, NAME, ID,   │
│      CODE, OBJECTID, FID；无则用序号 001/002/...）          │
│    - 用户可在下拉框中切换命名字段                           │
│    - 每行显示：序号 · 命名字段值 · 面积 · 瓦片数预估        │
│    - 全选/反选/按面积排序                                   │
├─────────────────────────────────────────────────────────────┤
│ 5. 下载参数共享：zoom, 瓦片源, 压缩, 并发                   │
│    批量并发度选择：串行 / 3 个 / 6 个并行（默认串行）       │
├─────────────────────────────────────────────────────────────┤
│ 6. 执行：                                                   │
│    for each selected feature:                               │
│      bounds = feature.bbox (计算 minX/maxY/maxX/minY)       │
│      polygon = feature.geometry                             │
│      filename = sanitize(properties[name_field])            │
│      save_path = `${batch_dir}/${filename}_z${zoom}.tif`    │
│      enqueue → invoke('create_download_task', {...})        │
├─────────────────────────────────────────────────────────────┤
│ 7. 全部完成后生成 manifest.json + failed.txt                │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 命名字段推荐算法

```js
function recommendNameField(properties_keys) {
    const priorities = [
        'name', 'NAME', 'Name',
        'title', 'TITLE',
        'id', 'ID', 'Id',
        'code', 'CODE',
        'objectid', 'OBJECTID', 'fid', 'FID',
    ];
    for (const key of priorities) {
        if (properties_keys.includes(key)) return key;
    }
    // 无匹配：返回第一个非 geometry 字段，由用户切换
    return properties_keys[0] || null;
}
```

**文件名安全化**：
```js
function sanitize(name, fallback_index) {
    if (!name) return String(fallback_index).padStart(3, '0');
    // 移除 Windows/macOS/Linux 文件名禁用字符
    return String(name)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/^\.+|\.+$/g, '')  // 移除首尾点
        .substring(0, 100)           // 限长
        .trim() || String(fallback_index).padStart(3, '0');
}
```

### 3.3 批量调度

```js
class BatchDownloadQueue {
    constructor(concurrency = 1) {
        this.concurrency = concurrency;
        this.queue = [];
        this.active = 0;
        this.completed = 0;
        this.failed = [];
    }

    add(task) {
        this.queue.push(task);
        this._run();
    }

    async _run() {
        while (this.active < this.concurrency && this.queue.length > 0) {
            const task = this.queue.shift();
            this.active++;
            this._execute(task)
                .catch(e => this.failed.push({ task, error: e }))
                .finally(() => {
                    this.active--;
                    this.completed++;
                    this._emitProgress();
                    this._run();
                });
        }
        if (this.queue.length === 0 && this.active === 0) {
            this._onDone();
        }
    }
    // ...
}
```

### 3.4 Manifest 结构

`{batch_dir}/manifest.json`：

```json
{
  "generated_at": "2026-04-17T15:30:00Z",
  "source_shapefile": "grids_study_area.shp",
  "feature_count_total": 12,
  "feature_count_downloaded": 11,
  "feature_count_failed": 1,
  "tile_source": "Google 卫星",
  "zoom_level": 18,
  "compression": "deflate",
  "features": [
    {
      "index": 1,
      "name_field_value": "北区格网_A",
      "filename": "北区格网_A_z18.tif",
      "bbox": [116.3, 39.9, 116.5, 40.0],
      "area_km2": 2.31,
      "tile_count": 1296,
      "file_size_bytes": 48217600,
      "status": "success",
      "properties": {
        "name": "北区格网_A",
        "area": 2.31,
        "code": "GRID_N01"
      }
    }
  ]
}
```

`{batch_dir}/failed.txt`：

```
002 | 北区格网_B | 失败原因
  task_id: abc-123
  error: 瓦片源 404 过多
```

### 3.5 并发策略

默认 **串行（并发=1）**，原因：
- Shapefile 中相邻要素地理位置可能重叠，共用同一批瓦片
- 串行可触发浏览器缓存 + 后端 HTTP/2 连接复用
- 避免同时对同一瓦片源发起过多请求触发 IP 限流

提供"3 并行"和"6 并行"选项给高带宽用户。

---

## 4. UI 设计

### 4.1 流程图

```
[加载 shp] → 检测到多要素
              ↓
   ┌──────────────────────────┐
   │ 模式选择对话框           │
   │                          │
   │ ○ 合并为单个范围         │
   │ ● 每个要素独立下载       │
   │                          │
   │  [继续]  [取消]          │
   └──────────────────────────┘
              ↓
   ┌──────────────────────────────────────────┐
   │ 批量下载面板                             │
   │                                          │
   │ 命名字段: [name ▼]                       │
   │                                          │
   │ ┌──────────────────────────────────┐    │
   │ │ ☑ 001 · 北区格网_A · 2.3km²  36▸ │    │
   │ │ ☑ 002 · 北区格网_B · 2.1km²  32▸ │    │
   │ │ ☑ 003 · 南区格网_A · 1.8km²  28▸ │    │
   │ │ ☐ 004 · 南区格网_B · 3.2km²  50▸ │    │
   │ │ ☑ 005 · 中央观测  · 0.9km²  14▸ │    │
   │ └──────────────────────────────────┘    │
   │  [全选] [反选] [按面积排序] [预览所有]   │
   │                                          │
   │ 并发: ○串行 ●3并行 ○6并行                │
   │                                          │
   │ 预估: 11 文件 / 4.2 GB / 48 分钟         │
   │                                          │
   │          [开始批量下载]  [取消]          │
   └──────────────────────────────────────────┘
              ↓
   ┌──────────────────────────────────────────┐
   │ 批量进度视图                             │
   │                                          │
   │ 总进度: ████████░░░░░░░ 8/11 (72%)       │
   │ 耗时: 32分 · 剩余 ~16分 · 失败 0         │
   │                                          │
   │ ✓ 001 北区格网_A.tif  (387 MB)           │
   │ ✓ 002 北区格网_B.tif  (342 MB)           │
   │ ⏳ 003 南区格网_A.tif  下载中 45%        │
   │ ⏸ 004 南区格网_B.tif  排队               │
   │ ...                                      │
   │                                          │
   │ [暂停全部] [取消剩余] [打开目录]         │
   └──────────────────────────────────────────┘
```

### 4.2 预览功能

- **要素列表行**点击 → 地图高亮该 feature，其他变灰
- **[预览所有]** 按钮：地图 fitBounds 全部要素
- **hover 行** → 显示该要素的完整 properties（JSON 弹窗）

### 4.3 失败处理

- 单个要素失败 → 标红 + "重试"按钮（仅重做该要素）
- [重试失败项] 批量按钮（仅处理失败队列）

---

## 5. 模块划分

### 5.1 新增文件

```
static/js/
  batch-download.js    # 批量调度队列 + manifest 生成（~300 行）
```

其余修改散落在现有 `app.js`（约 200 行新增）：
- `setBoundaryFromGeoJSON` 加分支：检测多 feature 时弹出模式选择
- 新增 `showBatchPanel(features)` 展示清单 UI
- 新增 `startBatchDownload(selections)` 入队并启动
- 新增 `renderBatchProgress(state)` 进度视图

### 5.2 HTML 改动

`static/index.html` 新增：
- `#batch-mode-dialog`：模式选择对话框
- `#batch-panel`：要素清单 + 预览 + 并发选择
- `#batch-progress-panel`：批量进度视图

### 5.3 后端改动

**无**。复用 `create_download_task`。

唯一可能需要的轻微扩展：
- `create_download_task` 返回 `task_id` 后，前端自己维护批次聚合。**确认现有 API 已返回 task_id，无需后端改动**。

---

## 6. 实施计划

### 6.1 里程碑

| 阶段 | 内容 | 工期 |
|---|---|---|
| **M1** | 模式选择对话框 + 要素清单 UI（静态展示） | 0.5 天 |
| **M2** | 命名字段推荐 + 文件名 sanitize + 要素高亮 | 0.25 天 |
| **M3** | 批量调度 `BatchDownloadQueue` + 并发控制 | 0.5 天 |
| **M4** | 进度聚合视图 + manifest.json 生成 | 0.25 天 |
| **打磨** | 错误处理 / 失败重试 / 文案 / 样式 | 0.25 天 |
| **测试** | 12 要素 shp、含中文属性、嵌套属性 | 0.25 天 |
| **总计** | | **~2 天** |

### 6.2 发布策略

- 作为 **v3.3.0** 主要特性之一
- 与 Wayback 增量（可选）并列推出
- 文档补充"批量 shp 工作流"教程

---

## 7. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|
| 非法属性值用作文件名 | 高 | 中 | `sanitize()` 函数，含非法字符替换 + 长度限制 + 重复后缀 `_002` |
| 要素过多（>100）UI 卡顿 | 中 | 中 | 列表虚拟滚动，或超 50 行时分页 |
| 相邻要素重叠瓦片浪费带宽 | 中 | 低 | 可选"共享瓦片缓存"模式（本地临时目录复用） |
| 属性字段值全相同导致文件同名 | 中 | 中 | 同名自动追加 `_{index}` 后缀 |
| 中文/特殊字符文件名路径问题 | 中 | 中 | 使用 Tauri path API 拼接，测试 Windows/macOS/Linux |
| 批量任务历史记录膨胀 | 低 | 低 | 批量任务合并为一条历史记录（父子结构） |
| 一个要素面积极大（如国家级） | 中 | 高 | 每要素走单任务的 max_tiles 校验，超额单独提示 |

---

## 8. 非目标

- ❌ 不实现要素属性编辑（仅读取）
- ❌ 不支持线（LineString）/ 点（Point）要素下载（仅 Polygon / MultiPolygon）
- ❌ 不做要素空间合并（用户自行在 GIS 中预处理）
- ❌ 不做影像镶嵌输出（独立文件即目标）

---

## 9. 后续演进

### 9.1 共享瓦片缓存（v3.4 候选）

相邻要素可能重叠，重复下载同一瓦片浪费带宽：

- 后端增加选项 `shared_tile_cache: true`
- 批量任务启动时创建共享临时目录
- 每个子任务下载前先检查共享缓存
- 全批次完成后再清理（或按 debug_mode 保留）

预期节省 10-30% 带宽（格网重叠场景）。

### 9.2 数字高程（DEM）支持（v3.4+）

**jojo 的补充需求**：

- 数据源：
  - SRTM 30m（全球免费，已有大量镜像）
  - Copernicus GLO-30（欧盟，免费注册）
  - NASADEM（NASA 改进版 SRTM，免费）
  - ASTER GDEM v3（日美联合）
- 输出格式：GeoTIFF Float32 灰度
- 挑战：DEM 瓦片服务较少，多为 WCS/WMS 或文件下载；需要专用数据通路
- 工作量：新增 DEM 源类型 + 专用 fetcher，~3-5 天

### 9.3 批量 + Wayback 组合（v3.5+）

批量下载 + 增量 Wayback 合流：对每个 feature 执行"按拍摄日期下载"，得到该区域的时间序列。科研场景终极形态。

---

## 10. 附录

### 10.1 用户需求时间线

- **2026-04-17 22:07** — 杨明旺首次提出需求
- **2026-04-17 22:xx** — 徐吉岩、jojo 等群友响应支持
- **2026-04-17 22:xx** — 高老师（作者）现场确认"一个 shp 多要素"场景
- **2026-04-17 23:xx** — 本文档落地

### 10.2 相关模块

- [static/js/app.js](../static/js/app.js) — 现有 Shapefile 加载与边界设置
- [static/js/api.js](../static/js/api.js) — `TifApi.createDownloadTask` 封装
- [static/lib/shp.js](../static/lib/shp.js) — shpjs 前端 Shapefile 解析库
- [src-tauri/src/commands.rs](../src-tauri/src/commands.rs) — `create_download_task` 后端实现（复用）
