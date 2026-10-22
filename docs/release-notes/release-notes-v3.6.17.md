# GeoD 3.6.17

## 中文

- 为天地图下载增加可选匿名诊断：本次尝试的当前 Token 配置数量、实际使用的不同 Token 数量、备用切换次数、切换后成功取得瓦片的次数、设置更新次数，以及最后一次 Token 被拒绝的 HTTP 状态。
- 下载开始与结束事件携带图源类别、处理阶段、最终错误类别和 HTTP 状态，可区分没有使用备用、切换后恢复、所有配置 Token 不可用，以及之后发生的合成或存储失败。
- 沿用匿名使用统计的同意开关。不采集 Token 值或指纹、请求地址、任务名、保存路径、坐标、原始错误和日志；客户端和采集服务均校验固定类别和有界计数。
- 保持旧客户端兼容，报表明确区分未采集的旧记录和真实的零次切换。切换后取片成功不等于整个任务完成，HTTP 状态也不能单独证明日额度耗尽。
- 保持现有多 Token 下载策略、内存预算仅提示和大任务进度行为。

## English

- Add opt-in anonymous Tianditu diagnostics: current configured token count, distinct tokens actually requested during an attempt, fallback switches, switches followed by a valid downloaded tile, settings updates, and the last rejected-token HTTP status.
- Include provider category, processing phase, final error category and HTTP status with download lifecycle events, separating fallback recovery, exhausted credentials, and subsequent processing/storage failures.
- Respect the existing telemetry consent switch. Never collect token values or fingerprints, request URLs, task names, paths, coordinates, raw errors or logs. Client and collector accept only fixed categories and bounded counts.
- Preserve legacy event compatibility; reports distinguish missing diagnostics from zero switches. A recovered tile does not imply task completion; HTTP status alone does not establish daily quota exhaustion.
- Keep token fallback behavior, advisory memory budgets and large-task progress unchanged.
