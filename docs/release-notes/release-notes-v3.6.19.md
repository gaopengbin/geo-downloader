# GeoDownloader v3.6.19

本次为界面稳定性修复，建议 3.6.18 用户更新。

- 修复切换图源或历史日期时，可能出现 React #185 并进入“界面渲染异常”的问题。
- 更新存在引用回调循环问题的下拉框、弹窗和菜单依赖，统一内部 Slot 依赖，避免混入旧副本。
- 保留 3.6.18 的历史影像浏览、下载进度、时间轴及已有任务、配置和成果。

验证：旧依赖在压缩生产构建中稳定复现 #185；修复后两个复现用例通过，连续切换和展开刷新共 240 次无异常；64 项前端测试、类型检查和生产构建通过。

## English

This patch fixes a React #185 crash that could occur when changing imagery sources or historical dates. It updates affected dropdown, dialog and menu dependencies and prevents legacy Slot copies from being bundled. Existing historical imagery features, tasks, settings and output files are retained.
