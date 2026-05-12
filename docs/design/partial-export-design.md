# 部分失败任务的导出策略 — 需求与实现计划

> 版本：草案 v1
> 创建：本会话
> 状态：等待开工确认

---

## 一、需求背景

用户场景：

1. 启动一个大数据量的下载（几十 GB 起，几十万 ~ 几百万瓦片）
2. 离开机器睡觉/出门
3. 下载过程中有少量瓦片由于网络抖动 / 图源临时不可用而失败
4. 醒来 / 回来后期望直接拿到一张 TIF 成果
5. **现状痛点**：
   - 部分失败的任务停在中间，不会自动导出 → TIF 没生成 → 用户暴躁
   - 任务进入"已中断"列表，点"继续下载"会复活下载流程，但当前 wayback 任务还会触发"未知图源"无法恢复
   - 想"删任务但保留缓存方便下次复用"做不到，"丢弃"会强制连缓存一起删

伴随发现的小 bug：

A. 中断的 wayback 任务点"继续下载"提示"未知图源：wayback_49059"
B. 丢弃任务对话框点"否"无任何反馈
C. 没有"删任务但保留缓存"的细粒度操作

---

## 二、设计原则

1. **幸福路径优先**：常见情况（少量失败）默认仍能拿到成果
2. **决策权交还用户**：通过设置项让严苛 / 宽松双方都能调
3. **不打扰**：不弹模态对话框打断用户睡眠 / 工作，状态信息体现在任务面板
4. **可逆**：用户当前的决策（即使误操作）都不能让缓存白下
5. **复用既有流水线**：不新增并行的下载/导出代码路径

---

## 三、最终行为规则

### 3.1 下载结束分支

```
下载循环结束 → success_ratio = success_count / total_count
              → min_ratio = AppSettings.min_export_success_ratio （默认 0.0）

if success_count == 0:
    任务标 Failed，不导出（硬规则）

else if success_ratio >= min_ratio:
    走自动合并 + 导出
    if failed_count == 0:
        任务标 Completed（现状）
    else:
        任务标 CompletedWithGaps（新状态）
        缓存目录保留，记录 missing_tiles 摘要

else:  // 0 < ratio < min_ratio
    任务标 Paused（待用户决策）
    缓存保留，不导出
```

### 3.2 设置项

| Key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `min_export_success_ratio` | `f32` (0.0 - 1.0) | `0.0` | 下载完成时成功率达到此值才自动导出。0=有 1 块成功也导，1=必须全成功才导 |

UI：设置页加滑块或数字输入，附说明文案。

### 3.3 任务面板新行为

#### CompletedWithGaps 状态条目

显示在已完成区，但带醒目缺块徽章：

| 缺块比例 | 徽章颜色 | 含义 |
|---|---|---|
| < 1% | 绿 | 基本完整 |
| 1% - 10% | 黄 | 偶有缺洞 |
| 10% - 50% | 橙 | 明显缺失 |
| > 50% | 红 | 强烈建议补漏 |

按钮：
- **补漏重导**（新）：调 `resume_task` 重试缺块 → 全成功后再次导出覆盖原 TIF
- **删除任务条目**（保留缓存）：从列表移除，缓存留在硬盘
- **删除任务+缓存**：彻底清理（即原"丢弃"行为）

#### Paused（低于阈值未导出）状态条目

按钮：
- **继续重试**（现有 `resume_task`）
- **强制按现状导出**（新）：调 `export_partial_task` 强制走合并/导出，不管成功率
- **丢弃**（两步对话框，见 3.4）

### 3.4 丢弃流程（拆两步对话框）

| 步 | 提问 | 否 = | 是 = |
|---|---|---|---|
| 1 | 确定从列表中移除此任务？ | 取消 | 进入步 2 |
| 2 | 是否同时删除已下载的瓦片缓存？（保留可下次复用） | 仅删任务条目，缓存留 | 任务条目+缓存全删 |

后端命令 `discard_resumable_task` 加参数 `delete_cache: Option<bool>`（默认 true 兼容旧调用）。

---

## 四、Bug 修复清单（已完成 / 待完成）

| # | Bug | 状态 |
|---|---|---|
| A | wayback 任务恢复"未知图源" | 已修（resume_task strip_prefix 分支） |
| B | 丢弃对话框点否无反馈 | 已修（拆两步对话框，否=取消） |
| C | 无"删任务保留缓存"选项 | 已修（步 2 选否） |
| D | 暂停后计时仍在跑 / 按钮没切 | 上一轮已修 |
| E | 取消任务后任务还在 | 上一轮已修 |

剩余开发任务（部分失败导出策略）：

| # | 任务 | 模块 |
|---|---|---|
| 1 | `AppSettings` 加 `min_export_success_ratio` 字段 + 默认 0.0 | settings.rs |
| 2 | `TaskStatus` 加 `CompletedWithGaps` | task.rs |
| 3 | `execute_download_task` 结束阶段按 3.1 分支判断 | commands.rs |
| 4 | 新命令 `export_partial_task(task_id)`：跳过下载直接合并导出 | commands.rs + merger/exporter |
| 5 | `PersistedTask` / `TaskInfo` 加 `failed_count` `success_count` 暴露给前端 | task.rs |
| 6 | 设置页加 `min_export_success_ratio` 滑块 + 说明 | settings-page.tsx |
| 7 | `tasks-panel.tsx`：CompletedWithGaps 区 + 缺块徽章 + 三个按钮 | tasks-panel.tsx |
| 8 | `tasks-panel.tsx`：Paused 区按钮加"强制按现状导出" | tasks-panel.tsx |
| 9 | `types/api.ts` 加新状态/字段 | types |
| 10 | "补漏重导"逻辑：resume 完成后自动触发 export_partial_task | resume_task 分支 |

---

## 五、需要确认的边界

1. **wayback 增量下载**（`download_wayback_incremental`）：是否同步纳入这套规则？
   - 推荐：纳入，行为一致
2. **3D Tiles 任务**：是否纳入？
   - 推荐：暂时不动（导出步骤跟 TIF 完全不同，无合并阶段）
3. **网络异常的判定**：
   - 当前：超过重试上限的瓦片才算 failed
   - 推荐：保持现状，不做特殊网络异常分流（用户不可控）
4. **"补漏重导"是否覆盖原 TIF**：
   - 推荐：覆盖（同名同路径）

---

## 六、上线步骤

1. 后端 1-5 + cargo check
2. 前端 6-10 + tsc + npm build
3. 实机测试：
   - 制造一个有失败瓦片的小任务（比如 token 错误图源），看是否自动按规则分流
   - 设置 `min_export_success_ratio=1.0`，看部分失败时是否进入 Paused 待决策区
   - 走"补漏重导"路径，看是否覆盖 TIF
   - 走"强制按现状导出"路径，看 TIF 是否生成
4. 文档更新到 changelog
5. 版本递增（建议 v3.4.5 或 v3.5.0）
