# 2026-05-07 瓦片缓存目录持久化加固

## 背景

QQ 群用户 -haipy 反馈：「我换缓存目录好像不成功，保存后重启还是原来默认目录」。

复盘原始流程：

1. 用户在「设置 → 瓦片缓存」点击文件夹按钮挑选目录 → 仅写入表单 state
2. 表单 `tile_cache_dir` 字段 `shouldDirty: true`，但用户必须再滚动到底部点「保存」按钮才会真正调用 `save_settings`
3. `save_settings` 调用 `tile_cache::set_root_dir`，但**只更新内存配置**，并未触发 `tile-cache-stats` 重新拉取，UI 上「分图源占用」一栏的 `rootDir` 还是旧值，造成「保存没生效」的视觉错觉
4. `cache_set_dir` 命令本身只更新内存，不写 settings.json；任何走它的入口都不会持久化

排查后无法立刻断言 `save_settings` 写盘失败（核心 `SettingsManager.save` 流程正确），所以本次修复采取**多重加固**：让任何修改路径的入口都立即落盘 + 立即刷新 UI，根除 -haipy 反映的现象。

## 改动

### 后端 `src-tauri/src/commands.rs`

`cache_set_dir` 命令在 `tile_cache::set_root_dir` 之后追加：

```rust
let manager = SettingsManager::new()?;
let mut s = manager.get()?;
s.tile_cache_dir = match &dir {
    Some(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
    _ => None,
};
manager.save(&s)?;
```

效果：任何调用 `cache_set_dir`（含选择器自动应用、重置）都会同步写入 `settings.json`，下次启动 `lib.rs::setup` 读到的就是新目录。

### 前端 `frontend/src/features/settings/tile-cache-section.tsx`

- 文件夹选择器 `handlePickDir`：拿到路径后立即 `setCacheDir(picked)` 持久化 + 失效 `tile-cache-stats` 与 `settings` 两个 query；toast 反馈「已切换并保存」
- 「重置」按钮：同样改为 `setCacheDir(null)`，立即恢复默认并落盘

### 前端 `frontend/src/features/settings/settings-panel.tsx`

`saveSettings` 成功回调追加 `queryClient.invalidateQueries({ queryKey: ['tile-cache-stats'] })`，让保存后 UI 立即显示新的 `rootDir`，不再有「保存没反应」的错觉。

## 验证

- `cargo check`：通过（dev profile 0.68s）
- `npm run build`（frontend）：通过（vite 417ms）

## 行为对比

| 操作 | 修复前 | 修复后 |
| --- | --- | --- |
| 选择新目录 | 仅写表单，需手动点「保存」；stats 不刷新 | 立即落盘 + 立刻 toast + stats 刷新 |
| 点重置 | 仅清空表单，需再点「保存」 | 立即恢复默认并落盘 |
| 表单点「保存」 | 不刷新缓存 stats，旧目录仍显示 | 同步刷新 stats 与 settings |
| 重启应用 | 若漏点保存则丢失 | 任意入口的修改都已持久化 |

## 影响面

仅瓦片缓存目录设置流程；不改动缓存数据本身或下载链路。

## 后续建议

如用户复现仍然不持久化，请让其检查 `%LOCALAPPDATA%\geo-downloader\settings.json` 中是否有 `tile_cache_dir` 字段，以确定是否为更深层的写盘权限问题。
