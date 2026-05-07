# 2026-05-07 多 zoom 模式「打开文件夹」找不到文件修复

## 现象

用户用 Wayback z11–z16 多级别 GeoTIFF 下载完成后，从历史记录点击「打开文件夹」，Windows 弹出错误：

> Windows 找不到文件 'E:\gis\tif\test\00\wayback_2026-04-30_z11-16_xxx.tif'。请确定文件名是否正确，再试一次。

但实际下载产物存在，分布在 `E:\gis\tif\test\00\z11\…\z16\` 各级子目录里。

## 根因

多 zoom 下载时（GeoTIFF / PNG / JPEG 三种「单文件 = 单 zoom」格式），后端 [`zoom_level_save_path`](../../src-tauri/src/commands.rs) 会把每个 zoom 的输出重写到 `<parent>/z<N>/<stem>_z<N>.<ext>`，而历史记录里持久化的 `file_path` 仍然是用户最初指定的「单文件路径」（即 `…/wayback_..._z11-16_xxx.tif`），这个路径在文件系统中实际不存在。

[`open_file_location`](../../src-tauri/src/commands.rs) 之前的逻辑：

```rust
let dir = if path.is_file() {
    path.parent().unwrap_or(path)
} else {
    path  // ← 路径不存在时直接当成目录交给 open::that
};
```

于是 `open::that(<不存在的文件路径>)` 让 Windows Shell 把它当文件去定位，弹出「找不到文件」对话框。

## 修复

[`src-tauri/src/commands.rs`](../../src-tauri/src/commands.rs) 重写 `open_file_location`：

1. 路径是已存在目录 → 直接打开
2. 路径是已存在文件 → 打开父目录
3. 路径不存在 → 逐级向上回退，找到第一个存在的目录再打开
4. 一路回退都找不到 → 退化到 `.`（避免崩溃，但实际不会发生）

这样：

- 多 zoom 模式下，回退到原始 `<parent>` 目录，用户可看到 `z11/`、`z12/`… 子目录
- 单 zoom 模式行为完全不变（文件存在 → 打开父目录）
- MBTiles/GPKG 模式行为不变（文件直接存在于原路径）
- 文件被用户手动移动/删除后，「打开文件夹」也能至少导航到附近目录

## 影响面

- 仅 `open_file_location` 命令一个函数
- 所有调用方（History 面板的「打开文件夹」按钮）自动受益
- 无前端改动
- 不影响下载流水线、不影响 history 数据库存储格式

## 验证

- `cargo check` 通过
- 手动测试：选 GeoTIFF、zoom 11–16、保存到 `E:\test`，下载完成后从历史记录点击「打开文件夹」，应弹出 `E:\test`（含 `z11`–`z16` 子目录）

## 备注

后续可考虑更优雅的方案：在历史记录持久化时，如果是多 zoom 模式，把 `file_path` 直接存为父目录路径（而不是不存在的单文件路径）。但那需要兼容旧记录，本次先用 fallback 方案覆盖症状。
