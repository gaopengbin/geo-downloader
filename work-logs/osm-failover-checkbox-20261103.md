# OSM 请求失败兜底与复选框修正（2026-11-03）

用户反馈任务复选框视觉不适，以及 OSM 道路下载出现 `Overpass API 请求失败: error sending request for url`。

当前代码核查结果：已有失败任务保留、历史记录和原子保存/文件核验；网络层仍为单一 `overpass-api.de` 请求，一次连接失败即结束，没有备用服务。

本次修改：

- 共享复选框改为 16px 方形标记、3px 圆角、20px 点击区；修复全局未分层 border-color 覆盖 Tailwind 工具类，增强边框对比，保留原生复选语义、焦点、禁用及键盘行为。任务标题和复选框在 20px 行内对齐。
- OSM 服务按 `overpass-api.de` → `maps.mail.ru` → `overpass.private.coffee` 顺序，连接/读取失败、超时、5xx 或无效响应依次尝试，每服务最多一次，单进程串行请求。
- 连接超时 10 秒、单请求上限 150 秒、一次查询总上限 300 秒。429/406 至少等待 30 秒，并遵守更长的 Retry-After；等待超过本次预算时保留失败，不绕过冷却。沿用用户配置的代理，不静默改走直连。
- HTTP 400 等查询拒绝不重复请求；HTTP 200 带 remark 的不完整结果视为失败，避免导出半截数据。
- 当前请求、备用切换、冷却等待提供中英文状态提示；错误摘要给出后续操作，原始分站原因保留在日志与悬停提示。沿用现有失败保留及文件核验流程。

验证：

- 前端构建、变更范围 ESLint、92 项前端测试通过。
- 8 项 Overpass 故障测试通过：主站正常不触及备用、断连/超时/截断/5xx/无效 JSON 失败切换、Retry-After、查询拒绝、不完整结果、空结果、总期限、取消时不再请求后续服务。
- 9 项原有 OSM 输出/任务/历史测试通过，包括失败不伪装完成、取消保留旧输出、历史失败持久化与严格文件检查。
- 两次真实小范围道路查询（Berlin 公共样区，未使用用户选区或凭据）：首次原站连接失败、private.coffee 超时、VK 成功，180.35 秒；将实测可用的 VK 前移后重测，原站连接失败自动切到 VK，52.86 秒生成 129 个道路要素，123,004 字节 GeoJSON，原子写入后读取核验通过。此结果仅反映本机此次网络条件。
- 浏览器隔离样例使用实际任务、历史、共享复选框及图层组件；原生 API/瓦片为模拟。验证勾选、空格键切换、焦点、380px 最小侧栏、中英文/深色主题，以及左侧勾选取消与右侧地图重新勾选的联动。未操作用户鼠标。

证据：`G:/code/tif-downloader/artifacts/osm-failover-checkbox-20261103/`，最终真实下载在 `final-order/berlin-roads.geojson` 与 `final-order/live-result.json`，UI 记录在 `ui-proof.json`，截图包含任务和叠加图层复选框。

请求策略参考：[Overpass 官方手册](https://dev.overpass-api.de/overpass-doc/en/preface/commons.html)、[OSM 公共实例列表](https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances)。本次仅本地修改，未发布更新。保留 1420 开发服务，关闭独立 1434 验证服务。
