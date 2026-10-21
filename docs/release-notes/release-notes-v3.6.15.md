# v3.6.15 — 注记叠加进度、缓存处理与错误统计修复

- **注记下载显示真实进度**：逐层显示注记名称、完成数量、失败与无数据数量，以及检查已有瓦片、查询缓存、读取缓存和重试阶段。总进度按主图和注记层分配，修复主图完成后长期停在 85% 的显示问题。
- **大任务分批处理**：已有瓦片校验、缓存查询和缓存恢复在后台按小批次执行，保留暂停、取消和恢复能力；界面更新及日志限频，避免大量缓存命中造成频繁刷新。
- **叠加合成更稳健**：合成输入采用受限图像解码；缓存恢复和合成时检查磁盘可用空间。存储异常明确停止任务并保留输入，不再作为可跳过的注记缺失继续导出。
- **下载错误分类更准确**：优先识别 Token 耗尽、访问拒绝、限流、无效瓦片和存储错误等稳定错误码，再归入现有分类。埋点仍只上报类别，不记录错误原文、文件路径或 Token；历史“未知原因”不会被猜测性改写。
- **配套运营报表修复**：已存在下载状态事件时，不再因缺少采集开始时间标记而显示“尚未采集”；明确区分首次观测时间和正式接入时间。只记录开始、未记录结束的任务不会被直接算作崩溃。

本次修复了已确认的进度、批量处理及统计问题；此前用户报告的长时间运行后闪退尚未复现，不能据此认定已解决所有闪退。

## English

- Show per-layer annotation download progress, counts, cache stages and retries. Allocate progress across base imagery and annotations instead of appearing stuck at 85%.
- Process existing-tile validation, cache lookup and cache restoration in bounded background batches. Preserve pause/cancel/recovery behavior and throttle UI/log updates.
- Apply bounded image decoding to composition inputs and check free disk space during restoration and composition. Preserve inputs and stop on storage errors rather than silently skipping annotations.
- Classify stable downloader error codes before matching general error wording. Keep the existing telemetry category schema; never send raw errors, paths or tokens. Historical unknown reasons remain unchanged.
- Fix the companion operational report so observed download lifecycle events remain reportable without an instrumentation-start marker. Distinguish first observation from a declared collection start, and missing terminal events from crashes.

The previously reported long-running process exit has not been reproduced; this release does not claim to resolve every crash.
