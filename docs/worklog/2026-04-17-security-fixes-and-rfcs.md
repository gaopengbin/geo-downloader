# 2026-04-17 工作日志

## 主线：4 份功能 RFC + 4 项 Critical 安全修复

---

## 一、功能 RFC 与 GitHub Issue

受社区提议启发，新增 4 份设计文档并同步提交 GitHub Issue，待后续排期实施。

| 文档 | 行数 | 对应 Issue | 主题 |
|---|---|---|---|
| [docs/wayback-incremental-design.md](wayback-incremental-design.md) | 324 | #7 | Wayback 历史影像增量下载（补齐 diff 切片，避免重复全量） |
| [docs/batch-shapefile-download-design.md](batch-shapefile-download-design.md) | 324 | #4 | 批量 Shapefile 下载（按字段拆分/并发导出多文件） |
| [docs/tiff-pyramid-overviews-design.md](tiff-pyramid-overviews-design.md) | 322 | #5 | GeoTIFF 金字塔 overviews（生成多级缩略以加速大图预览） |
| [docs/dem-download-design.md](dem-download-design.md) | 394 | #6 | DEM 数据下载（AWS Terrain Tiles 为主源，含高程解码与合并） |

**合计**：1,364 行 RFC + 4 个 GitHub Issue。

---

## 二、Critical 安全修复（4/6 完成）

本轮聚焦前期代码审计标记的 6 个 Critical，其中 4 项已修复合入：

### C1 — `tile.rs` u32 溢出

- **风险**：`2.0_f64.powi(zoom as i32) as u32` 在 `zoom > 31` 时饱和为 `u32::MAX`，后续 `cols * rows` 直接溢出 panic / 产生错误瓦片数量估算
- **修复**：
  - 新增 `const MAX_ZOOM: u8 = 24`（覆盖真实瓦片源最大 z23）+ `clamp_zoom()` 助手
  - `latlng_to_tile` 改用 `(1u64 << zoom) as u32` + NaN/负数守卫
  - `estimate_tile_count` 全程 u64 中间量，`saturating_mul` 后 clamp 到 `u32::MAX`
  - `get_tile_matrix_size` 使用 `saturating_sub` / `saturating_add`
  - 所有公开函数入口 clamp zoom
- **验证**：`cargo test --lib tile::` 4/4 通过
- 涉及文件：`src-tauri/src/tile.rs`

### C2 — TLS 证书验证硬编码跳过

- **风险**：3 处 `reqwest::ClientBuilder::danger_accept_invalid_certs(true)` 强制关闭证书校验，MITM 风险
- **修复策略**：用户可控开关 + 默认严格
  - `settings.rs`：新增 `allow_invalid_certs: bool`（默认 `false`）+ 安全警告文档注释
  - `config.rs`：新增 `static ALLOW_INVALID_CERTS: AtomicBool` + `set_allow_invalid_certs()` / `allow_invalid_certs()` 公开 API
  - `lib.rs::setup`：启动时从 `SettingsManager` 读取初值同步到原子量
  - `commands.rs::save_settings`：用户变更设置后即时同步，无需重启
  - 3 处构造器：`.danger_accept_invalid_certs(config::allow_invalid_certs())`
- **涉及文件**：`settings.rs`、`config.rs`、`lib.rs`、`commands.rs`、`downloader.rs`、`tiles3d/fetcher.rs`
- **坑**：过程中 `multi_replace_string_in_file` 对 3 处替换产生了拼接异常（`newString` 被追加到 `oldString` 残留之后），编译失败 9 处。单独修复后通过。**教训**：涉及多文件同形替换时，优先分开单文件调用；批替换务必 `get_errors` 或编译验证。

### C5 / C6 — 前端 XSS 注入

- **风险**：`app.js` 多处直接拼接用户数据到 `innerHTML`，可注入 `<script>` 或事件属性
- **修复**：
  - 新增 `escapeHtml(str)` + `escapeAttr(str)` 工具函数（文件顶部，regex-replace 实现，同时覆盖引号和反引号）
  - 删除文件底部重复定义的弱版本 `escapeHtml`
  - 7+ 处插入点全部转义：搜索结果、更新弹窗说明、自定义数据源列表、内建数据源列表、任务卡片、历史卡片、任务日志面板、历史日志时间戳、GeoJSON popup 属性
  - 将内联 `onclick="copyTaskLogs('${taskId}')"` 之类改为 `data-task-id` + `addEventListener` 事件委托模式（彻底避免属性注入）
- **验证**：
  - `node --check` 语法通过
  - 浏览器打开实测 `escapeHtml('<img src=x onerror=alert(1)>"``\'')` → `&lt;img src=x onerror=alert(1)&gt;&quot;` `` `&#39;``（全部中和）
- **涉及文件**：`static/js/app.js`

---

## 三、验证

| 类型 | 命令 | 结果 |
|---|---|---|
| Rust 语法 | `cargo check` | Finished |
| tile 单测 | `cargo test --lib tile::` | 4 passed |
| 前端语法 | `node --check static/js/app.js` | pass |
| DOM 渲染 | 浏览器直开 `static/index.html` | 正常渲染（瓦片 403 为 OSM 反爬策略，与代码无关） |
| 转义函数 | 浏览器 console 注入 XSS payload | 全部转义为 HTML 实体 |
| **真实烟测** | `cargo tauri dev` | **Finished 20s，应用窗口正常启动，无 panic** |

---

## 四、剩余工作

- ⏳ **C3 / C4 exporter OOM**：导出器在大面积下载时可能出现内存风险（`Vec` 聚合未流式处理）。改造面较大，建议单独 RFC + Issue 排期，本次不合入。
- ⏳ **提交**：建议拆分为两个独立 commit —— 一个纯 4 RFC，一个纯 4 安全修复。

---

## 五、其他

- 群公告：多版本交付
- 代码质量审计：87 项问题已归档，6 项 Critical 本次处理 4 项
