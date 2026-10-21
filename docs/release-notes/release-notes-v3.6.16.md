# v3.6.16 — 大任务合成与原始目录导出进度修复

- **合成进度更直观**：启用叠加时，主图和注记下载合计占 0～60%，合成占 60～88%，导出从 88% 继续。避免几十万张合成任务长时间只移动不到一个百分点；未启用叠加时保留原下载占比。
- **原始瓦片目录导出显示实时计数**：显示“写出原始瓦片目录：已处理/总数”，按实际成功移动或写入的文件推进至 99%；任务收尾完成后再到 100%。PBF 目录使用同一计数机制。
- **进度与日志限频**：界面约每半秒刷新一次，开始和结束及时显示；日志按进度区间或时间间隔记录，避免大任务产生海量刷新。导出失败时不会把失败文件计为成功。

本版调整进度反馈，不改变瓦片合成内容、导出格式或内存预算仅提示的策略。

## English

- Allocate overlay jobs across downloads (0–60%), composition (60–88%) and export (88% onward), so large composition jobs visibly advance. Keep the existing base-download allocation when overlays are disabled.
- Show processed/total counts while exporting raw XYZ and PBF folders. Advance only after each successful file move or write, reach 99% after export, and reserve 100% for task completion.
- Throttle UI updates to approximately twice per second while keeping initial/final updates immediate. Limit progress logs and never count a failed file as successfully exported.

This release changes progress reporting without changing composited image content, export formats or the warning-only memory-budget policy.
