export type Position = [number, number];
export type ClipPolygon = { type: "Polygon"; coordinates: Position[][] };
export type ClipMultiPolygon = { type: "MultiPolygon"; coordinates: Position[][][] };
export type ClipGeometry = ClipPolygon | ClipMultiPolygon;

const MAX_LAT = 85.05112878;
const MAX_POINTS = 20_000;
const MAX_RINGS = 512;
const MAX_POLYGONS = 256;

export function validateClipGeometry(input: unknown): ClipGeometry {
  let value = input;
  if (value && typeof value === "object" && !Array.isArray(value) && "type" in value && value.type === "Feature") {
    value = (value as { geometry?: unknown }).geometry;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !("type" in value) || !("coordinates" in value)) {
    throw new Error("裁剪边界需要 GeoJSON Polygon、MultiPolygon 或包含它们的 Feature。");
  }
  const geometry = value as { type: unknown; coordinates: unknown };
  if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") {
    throw new Error("裁剪边界只支持 GeoJSON Polygon 或 MultiPolygon。");
  }
  const rawPolygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(rawPolygons) || rawPolygons.length < 1 || rawPolygons.length > MAX_POLYGONS) {
    throw new Error("裁剪边界的多边形数量无效或超过 256 个。");
  }
  let points = 0;
  let ringCount = 0;
  const polygons: Position[][][] = rawPolygons.map(rawPolygon => {
    if (!Array.isArray(rawPolygon) || rawPolygon.length < 1) throw new Error("每个裁剪多边形至少需要一个外环。");
    return rawPolygon.map(rawRing => {
      if (!Array.isArray(rawRing) || rawRing.length < 3 || ++ringCount > MAX_RINGS) {
        throw new Error("裁剪边界环至少需要 3 个点，且总环数不能超过 512。");
      }
      const ring: Position[] = rawRing.map(rawPoint => {
        if (!Array.isArray(rawPoint) || rawPoint.length < 2 || !Number.isFinite(rawPoint[0]) || !Number.isFinite(rawPoint[1]) || ++points > MAX_POINTS) {
          throw new Error("裁剪边界的坐标无效，或超过 20000 个点。");
        }
        const [lon, lat] = rawPoint;
        if (lon < -180 || lon > 180 || lat < -MAX_LAT || lat > MAX_LAT) {
          throw new Error("裁剪边界必须使用 WGS84 经纬度，纬度限于 Web Mercator 可显示范围。");
        }
        return [lon, lat];
      });
      if (new Set(ring.map(point => point.join(","))).size < 3) throw new Error("裁剪边界环至少需要 3 个不同的点。");
      const first = ring[0], last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first]);
      return ring;
    });
  });
  return geometry.type === "Polygon"
    ? { type: "Polygon", coordinates: polygons[0] }
    : { type: "MultiPolygon", coordinates: polygons };
}

export function clipBounds(geometry: ClipGeometry): [number, number, number, number] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let west = 180, south = MAX_LAT, east = -180, north = -MAX_LAT;
  for (const polygon of polygons) for (const ring of polygon) for (const [lon, lat] of ring) {
    west = Math.min(west, lon); south = Math.min(south, lat);
    east = Math.max(east, lon); north = Math.max(north, lat);
  }
  return [west, south, east, north];
}
