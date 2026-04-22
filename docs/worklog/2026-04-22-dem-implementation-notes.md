# DEM 下载实现与实测观察

日期：2026-04-22
关联 issue：#6（DEM 高程下载）
代码提交：（待提交）

---

## 一、实现摘要

### 后端

- `src-tauri/src/dem/`
  - `mod.rs`：`DemSource` 枚举 + `is_dem_source()`，目前仅 `Terrarium`
  - `terrarium.rs`：解码工具 `decode_pixel(r, g, b) -> f32` + 单元测试
- `src-tauri/src/streaming_tiff.rs`：新增 `merge_and_export_dem_streaming()`
  - Float32 单波段 BigTIFF（SampleFormat=3 IEEEFP）
  - 投影 EPSG:4326（与影像导出一致）
  - GDAL_NODATA = `-9999.0`（tag 42113）
  - 双缓冲流水线（rayon 解码 + 独立写盘线程）
  - 支持 LZW / Deflate / 无压缩
  - 支持多边形裁剪：环外像素强制写 NoData
- `src-tauri/src/config.rs`：注册 `dem_terrarium` 数据源（max_zoom=15）
- `src-tauri/src/commands.rs`：`is_dem_source(request.source)` → DEM 流式分支

### 前端

- `static/index.html`：顶部 mode-toggle 增加 **DEM 高程** 按钮
- `static/js/app.js`：
  - `currentMode` 取值扩展为 `'tif' | 'dem' | '3dtiles' | 'wayback'`
  - `rebuildSourceSelectForMode(mode)`：DEM 模式仅显示 DEM 源，其他模式过滤掉 DEM 源
  - `applyDemFormatLock()`：选 DEM 源时强制 GeoTIFF 并禁用格式选择
  - DEM 模式与 GeoTIFF 模式共用下载面板（仅数据源/格式不同）

---

## 二、Terrarium 编码

公式：

```
elevation_m = (R * 256 + G + B / 256) - 32768
```

- 范围：-32768.0 ～ +32767.996 m
- 理论精度：1/256 m ≈ 3.9 mm
- 实际数据：NASADEM + SRTM + GEBCO 等融合，PNG 压缩有轻微损失

数据源 URL：

```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
```

最大 zoom：15（z15 之上 AWS 不再产出新 tile）

---

## 三、QGIS 实测观察（台湾）

### 值范围判读

| 缩放 | 最大值 | 最小值 | 说明 |
|------|--------|--------|------|
| z10  | 3,640  | -9,989 | 最低值接近 -9999 是 NoData；最高 3,640m 是经过 z10 重采样平滑后的玉山 |
| z14  | 1,410  | -8,320 | **-8,320 是真实海底数据**（琉球海沟附近），不是 NoData |

**注意**：QGIS 显示的 min/max 来自图层的真实像素值。NoData (-9999) 会被排除，但海洋的真实负值（深海地形）会被算进去。

### 视觉效果

- 多边形外像素正确显示为黑色（NoData）
- 岛屿轮廓清晰，中央山脉呈现亮带（高程渐变正确）
- 海域出现零散白点：澎湖、绿岛、兰屿等小岛若在用户绘制的多边形内部，会保留 Terrarium 数据；若想纯台湾本岛需更精细绘制多边形

---

## 四、已知约束 / 设计妥协

### 1. EPSG:4326 输出 + Mercator 切片采样

Terrarium 切片本身在 Web Mercator 上等高，但代码输出标记为 EPSG:4326（经纬度等距）。这会导致：

- **像素 y 方向并非纬度等距**，高纬度区域被略微"压扁"
- 台湾纬度 23°，垂直方向偏差 < 1%，肉眼不可见
- 极地/高纬区域（> 60°）会有可见变形

**未来优化方向**：
- 选项 A：输出 EPSG:3857，bounds 用 mercator 边界（彻底正确，但用户更熟悉 EPSG:4326）
- 选项 B：在 Float32 写入时按纬度做重采样（每行像素插值到 EPSG:4326 等距网格）

### 2. 海底地形不是 NoData

Terrarium 包含完整海底高程（GEBCO 数据），不是 0。如果只想要陆地：

- **下载前**：在多边形内严格圈出陆地
- **下载后**：QGIS 栅格计算器 `("layer@1" >= 0) * "layer@1"` 把负值置为 NoData

### 3. 只有一个 DEM 源

免授权全球 DEM 瓦片源市面上唯一可立即接入的就是 AWS Terrarium。

后续候选：

| 源 | 编码 | 接入难度 | 备注 |
|----|------|----------|------|
| Mapbox Terrain-RGB | `(R*65536+G*256+B)*0.1-10000` | 低 | 需 Mapbox token |
| OpenTopography GeoTIFF API | 直接 GeoTIFF | 中（非瓦片流程） | 需 API key，按区请求 |
| Copernicus GLO-30 | COG range | 高 | 需独立模块，30m 全球 |

---

## 五、原规划数据源详细对比（来自 dem-download-design.md）

参考 [docs/dem-download-design.md](../dem-download-design.md) 第 2 章。

### A. 完整源清单与数据格式

| 数据源 | 分辨率 | 覆盖 | 认证 | 数据格式 | 接入路径 |
|---|---|---|---|---|---|
| **AWS Terrain Tiles (Terrarium)** ✅已实现 | z0-15 (~4.8m@赤道) | 全球 | 无 | **PNG 瓦片**（Terrarium 编码） | 复用现有瓦片下载器 |
| Mapbox Terrain-RGB | z0-15 | 全球 | API Key | **PNG 瓦片**（Mapbox 编码） | 同 Terrarium，编码公式不同 |
| Copernicus GLO-30 | 30m | 全球 | 无（AWS 公开桶） | **COG GeoTIFF** | HTTP Range 读取 + 重采样 |
| NASADEM | 30m | 60°N-56°S | 无（AWS 公开） | GeoTIFF（按 1°×1° 文件） | 文件列表 + 拼接 |
| SRTM 1-Arc-Second | 30m | 60°N-56°S | 无 | **HGT** 二进制 | 解析 HGT + 转 GeoTIFF |
| ASTER GDEM v3 | 30m | 83°N-83°S | NASA Earthdata 注册 | GeoTIFF | 注册 + REST API |
| ALOS AW3D30 | 30m | 全球 | JAXA 注册 | GeoTIFF | 注册 + 文件分发 |
| Copernicus GLO-90 | 90m | 全球 | 无 | COG | 同 GLO-30，仅分辨率不同 |

### B. 三种数据格式的接入差异

#### 1. PNG 瓦片编码型（Terrarium / Mapbox Terrain-RGB）

- **架构同构**：与现有影像瓦片完全一致的 `{z}/{x}/{y}.png` URL 模式
- **接入成本**：极低，复用 fetcher / merger / 流式导出
- **核心差异**：编码公式不同
  - Terrarium：`(R*256 + G + B/256) - 32768`
  - Mapbox：`(R*65536 + G*256 + B) * 0.1 - 10000`
- **精度**：受 PNG 8-bit 量化限制（Terrarium 1/256m，Mapbox 0.1m）

#### 2. Cloud Optimized GeoTIFF（Copernicus GLO-30/90）

- **架构差异**：不是瓦片化数据
  - 按 1° × 1° 经纬度网格组织文件
  - 每个 COG 内部已分块（block），可用 HTTP Range 读子区域
- **典型路径**：`s3://copernicus-dem-30m/Copernicus_DSM_COG_10_N23_00_E121_00_DEM/...tif`
- **接入成本**：中-高
  - 需要：文件清单查询 + Range Request 客户端 + GeoTIFF 解析 + 重采样到目标网格
  - 推荐用 `gdal-rs` 或纯 Rust `tiff` crate（已在依赖中）
- **精度**：原生 Float32，无 PNG 损失，最权威

#### 3. 直接文件型（NASADEM / SRTM HGT / ASTER）

- **架构差异**：需要"文件下载器"而非"瓦片下载器"
  - 列表 → 多文件并行下载 → 解析 → 拼接
  - SRTM HGT 是裸二进制（每个文件 1° × 1°，3601×3601 个 int16）
- **接入成本**：中
- **额外问题**：部分需账号注册（ASTER / ALOS）

### C. 为什么 v3.4 只先做 Terrarium

1. **架构同构**：100% 复用现有瓦片下载链路，无需新增网络层 / 文件管理
2. **零认证**：用户即开即用，不需要去 Mapbox 注册
3. **覆盖全球**：包含极地（Mapbox/SRTM 不全）
4. **足够日常**：z14 ≈ 9.5m/pixel @ 赤道，对地形分析、3D 建模够用
5. **MVP 优先**：先把"DEM 能下、能裁、能用 QGIS 打开"的端到端跑通，再扩源

### D. 后续扩源的优先级建议

| 顺序 | 源 | 预期工作量 | 核心收益 |
|------|----|-----------|---------|
| 1 | Mapbox Terrain-RGB | 1-2 小时 | 仅需加一个解码分支 + token 输入；用户已有 Mapbox 账号时立即可用 |
| 2 | Copernicus GLO-30 | 1-2 天 | 高精度 Float32 原生数据，覆盖大区域无瓦片化损失 |
| 3 | SRTM HGT | 半天 | 经典科研数据，离线可用 |
| 4 | NASADEM / ALOS / ASTER | 各 1 天 | 特定场景需求 |

---

## 六、关键代码片段

### 1. 多边形扫描线裁剪（DEM 专用）

```rust
let pixel_rings: Vec<Vec<(i32, i32)>> = if let Some(polys) = polygons {
    let lng_span = bounds.east - bounds.west;
    let lat_span = bounds.north - bounds.south;
    polys.iter()
        .map(|ring| ring.iter().map(|p| {
            let x = ((p.lng - bounds.west) / lng_span * width as f64) as i32;
            let y = ((bounds.north - p.lat) / lat_span * height as f64) as i32;
            (x, y)
        }).collect())
        .filter(|r: &Vec<(i32, i32)>| r.len() >= 3)
        .collect()
} else { Vec::new() };
```

注意：DEM 用纬度等距映射 y（与像素映射一致），而 RGB streaming_tiff 用 `mercator_y` —— 因为两者写入的是不同的"虚拟坐标系"，关键是**裁剪坐标系必须与像素映射一致**才不会错位。

### 2. BigTIFF Float32 IFD（16 个 entry）

包含 GDAL_NODATA tag 42113（ASCII `-9999\0`）和 SampleFormat tag 339 = 3 (IEEEFP)。

### 3. 前端模式切换

```javascript
function rebuildSourceSelectForMode(mode) {
    const wantDem = mode === 'dem';
    const entries = Object.entries(tileSourceConfigs)
        .filter(([key]) => isDemSource(key) === wantDem)
        .sort((a, b) => a[1].name.localeCompare(b[1].name));
    // ... 重建 options + 锁定格式
}
```

---

## 七、验证清单

- [x] cargo check 通过
- [x] node -c static/js/app.js 通过
- [x] cargo tauri dev 启动成功
- [x] 实测下载 z10 / z14 台湾区域，QGIS 加载成功
- [x] 多边形裁剪生效（环外 NoData）
- [x] Float32 数据被 QGIS 正确识别（拉伸渲染显示高程渐变）
- [ ] 极地/高纬区域测试（暂不需要）
- [ ] 多 DEM 源支持（待规划）
