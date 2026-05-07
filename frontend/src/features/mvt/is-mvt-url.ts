// MVT 图源识别：URL 含 .pbf / .mvt 或 format=mvt 或匹配已知 MVT 服务
export function isMvtUrl(url: string | undefined | null): boolean {
  if (!url) return false
  if (/\.(pbf|mvt)(\?|$)/i.test(url)) return true
  if (/[?&]format=(mvt|pbf)/i.test(url)) return true
  // 已知公开 MVT 服务（无后缀）
  if (/tiles\.versatiles\.org\/tiles\/(osm|landuse|natural)/i.test(url)) return true
  return false
}
