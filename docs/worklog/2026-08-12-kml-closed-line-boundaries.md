# 2026-08-12 KML 闭合线边界兼容

## 现象

用户提供的县域 KML 在常见地图软件中能显示为完整边界，但导入 GeoD 后提示未发现面要素。

## 根因

文件没有使用标准 `Polygon`，而是在 `MultiGeometry` 中使用多条首尾闭合的 `LineString` 表示区域边界。`@tmcw/togeojson` 按 KML 语义正确解析为线，GeoD 的区域选择器只接受 `Polygon` / `MultiPolygon`，因此没有可用下载区域。

早期 KML/KMZ 导入测试样例只覆盖标准 `Polygon`，没有覆盖部分 GIS 软件和转换流程输出的闭合边界线。

## 修复

- KML/KMZ 解析后增加区域几何归一化。
- 首尾坐标闭合且至少包含 4 个坐标的 `LineString` 转换为 `Polygon`。
- 全部闭合的 `MultiLineString` 转换为 `Polygon` 或 `MultiPolygon`。
- 递归处理 `GeometryCollection`；集合全部为面时折叠为面几何。
- 开放线、点和混合几何继续保留原有类型，避免把普通线路或轨迹误判为下载区域。
- 标准 `Polygon` / `MultiPolygon` 不做修改。

此归一化只接入 KML/KMZ 导入链路，不改变 GeoJSON 和 Shapefile 的既有语义。

## 验证

- 单条闭合线转换为面。
- 多条闭合线转换为多面。
- `MultiGeometry` 闭合线递归转换。
- 开放线不转换。
- 标准面保持不变。
- 混合几何保留开放线。
- 使用用户反馈文件核对两段闭合边界均被识别，并整理为 `MultiPolygon`。
