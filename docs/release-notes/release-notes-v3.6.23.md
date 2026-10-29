# GeoD v3.6.23

本次修复 Esri Wayback 历史日期切换时的界面崩溃，建议使用历史影像功能的用户更新。

- 修复在日期下拉框中选择其他日期，或通过时间轴切换日期时，可能触发 React #185 并进入“界面渲染异常”的问题。
- 调整日期同步方式，消除侧栏日期与地图预览日期互相回写的循环；下拉框、时间轴和当前预览保持一致。
- 重复选择同一日期时，不再触发无效的预览状态更新。
- 保留 3.6.22 已发布的图层预检查、诊断设置与现有图源、任务、配置和成果。

发布流程同步增加版本与说明文件的打包前校验；镜像同步不再依赖历史 Actions 构建成功或短期产物，支持正式 Release 补发后的状态收敛。

验证：实际 Wayback 页面在修复前可稳定复现压缩生产构建的 #185；修复后连续 30 次下拉日期切换、30 次时间轴切换，以及刷新、单个/批量/增量模式往返均通过。69 项前端测试及 TypeScript / Vite 生产构建通过。

## English

GeoD 3.6.23 fixes a React #185 crash when changing Esri Wayback dates through the dropdown or timeline. Sidebar and map-preview state no longer overwrite each other in a render loop, and selecting the same date avoids redundant preview updates.

The fix was verified using the actual Wayback page and timeline in a minified production build, including 60 date changes and mode switches. All 69 frontend tests and the production build passed. Existing 3.6.22 features, settings, tasks and exported files are retained.
