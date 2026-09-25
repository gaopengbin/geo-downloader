import { requireBrowserZoomAccess } from "./browser-access";

export type BrowserSource = {
  id: string;
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
  tileSize: 256 | 512;
  scheme: "xyz" | "tms";
  subdomains: string[];
};

export type BrowserSourceStore = { defaultSourceId: string; customSources: BrowserSource[] };

const STORAGE_KEY = "geod.browser.sources.v1";
const MAX_CUSTOM_SOURCES = 20;

export const BROWSER_SOURCE: BrowserSource = {
  id: "nasa_gibs_blue_marble",
  name: "NASA GIBS Blue Marble",
  url: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg",
  attribution: "NASA GIBS / Blue Marble；地形概览图，不是近期卫星影像",
  maxZoom: 8,
  tileSize: 256,
  scheme: "xyz",
  subdomains: [],
};

export function validateBrowserSource(value: unknown): BrowserSource {
  if (!value || typeof value !== "object") throw new Error("请填写图源信息。");
  const input = value as Record<string, unknown>;
  const id = String(input.id ?? "").trim();
  const name = String(input.name ?? "").trim();
  const url = String(input.url ?? "").trim();
  const attribution = String(input.attribution ?? "").trim();
  const maxZoom = Number(input.maxZoom);
  const tileSize = Number(input.tileSize ?? 256);
  const scheme = input.scheme ?? "xyz";
  const subdomains = input.subdomains ?? [];
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || id === BROWSER_SOURCE.id) throw new Error("图源 ID 需为 1–64 位英文字母、数字、- 或 _，且不能占用内置图源 ID。");
  if (!name || name.length > 128) throw new Error("图源名称需为 1–128 个字符。");
  if (!attribution || attribution.length > 1024) throw new Error("请填写图源来源和署名，不超过 1024 个字符。");
  if (!Number.isInteger(maxZoom) || maxZoom < 0 || maxZoom > 22) throw new Error("最大级别需为 0–22 的整数。");
  if (tileSize !== 256 && tileSize !== 512) throw new Error("瓦片尺寸只能是 256 或 512 像素。");
  if (scheme !== "xyz" && scheme !== "tms") throw new Error("瓦片行号方式只能是 XYZ 或 TMS。");
  if (!Array.isArray(subdomains) || subdomains.length > 8 || subdomains.some(item => typeof item !== "string" || !/^[A-Za-z0-9]{1,16}$/.test(item))) {
    throw new Error("子域名最多 8 个，每个只能含英文字母或数字。");
  }
  if (url.length > 8192 || !url.includes("{z}") || !url.includes("{x}") || !url.includes("{y}")) {
    throw new Error("瓦片地址必须包含 {z}、{x}、{y}，且不超过 8192 个字符。");
  }
  const placeholders = url.match(/\{[^}]+\}/g) ?? [];
  if (placeholders.some(item => !["{z}", "{x}", "{y}", "{s}"].includes(item)) || (url.includes("{s}") && subdomains.length === 0)) {
    throw new Error("瓦片地址只支持 {z}、{x}、{y}、{s}；使用 {s} 时请填写子域名。");
  }
  let parsed: URL;
  try { parsed = new URL(url.replaceAll("{z}", "0").replaceAll("{x}", "0").replaceAll("{y}", "0").replaceAll("{s}", String(subdomains[0] ?? "a"))); }
  catch { throw new Error("瓦片地址不是有效的 HTTPS URL。"); }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw new Error("浏览器图源必须使用 HTTPS，且不能包含 URL 用户名、密码或片段。");
  }
  if (parsed.hostname === "basemaps.cartocdn.com" || parsed.hostname.endsWith(".basemaps.cartocdn.com")) {
    throw new Error("CARTO Basemaps 需要用户自己的 API Key，且当前条款禁止批量提取；请使用明确允许下载的图源。");
  }
  return { id, name, url, attribution, maxZoom, tileSize, scheme, subdomains: [...subdomains] };
}

export function browserTileUrl(source: BrowserSource, zoom: number, x: number, y: number): string {
  const row = source.scheme === "tms" ? 2 ** zoom - 1 - y : y;
  const subdomain = source.subdomains.length ? source.subdomains[(x + y) % source.subdomains.length] : "";
  return source.url.replaceAll("{z}", String(zoom)).replaceAll("{x}", String(x)).replaceAll("{y}", String(row)).replaceAll("{s}", subdomain);
}

export function readBrowserSources(): BrowserSourceStore {
  const empty = { defaultSourceId: BROWSER_SOURCE.id, customSources: [] };
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text || text.length > 200_000) return empty;
    const saved = JSON.parse(text);
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.customSources) || saved.customSources.length > MAX_CUSTOM_SOURCES) return empty;
    const customSources = saved.customSources.map(validateBrowserSource);
    if (new Set(customSources.map((source: BrowserSource) => source.id)).size !== customSources.length) return empty;
    const defaultSourceId = [BROWSER_SOURCE, ...customSources].some(source => source.id === saved.defaultSourceId)
      ? saved.defaultSourceId : BROWSER_SOURCE.id;
    return { defaultSourceId, customSources };
  } catch { return empty; }
}

export function saveBrowserSources(store: BrowserSourceStore): BrowserSourceStore {
  if (store.customSources.length > MAX_CUSTOM_SOURCES) throw new Error(`当前浏览器最多保存 ${MAX_CUSTOM_SOURCES} 个自定义图源。`);
  const customSources = store.customSources.map(validateBrowserSource);
  if (new Set(customSources.map(source => source.id)).size !== customSources.length) throw new Error("图源 ID 不能重复。");
  const defaultSourceId = [BROWSER_SOURCE, ...customSources].some(source => source.id === store.defaultSourceId)
    ? store.defaultSourceId : BROWSER_SOURCE.id;
  const next = { defaultSourceId, customSources };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 1, ...next })); }
  catch { throw new Error("当前浏览器无法保存图源，请检查站点存储权限或剩余空间。"); }
  return next;
}

export async function probeBrowserSource(source: BrowserSource, zoom: number, x: number, y: number, signal?: AbortSignal) {
  await requireBrowserZoomAccess(zoom);
  if (![zoom, x, y].every(Number.isInteger) || zoom < 0 || zoom > source.maxZoom || x < 0 || y < 0 || x >= 2 ** zoom || y >= 2 ** zoom) {
    throw new Error("检测瓦片坐标超出图源支持的范围。");
  }
  let response: Response;
  try { response = await fetch(browserTileUrl(source, zoom, x, y), { mode: "cors", credentials: "omit", signal }); }
  catch { throw new Error("浏览器无法读取该图源瓦片，请检查地址、网络和图源的 CORS 设置。"); }
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error(`图源瓦片返回 HTTP ${response.status}，或返回内容不是图片。`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  if (size.width !== size.height || ![256, 512].includes(size.width)) throw new Error("图源瓦片需为 256 × 256 或 512 × 512 的正方形图片。");
  return { ok: size.width === source.tileSize, sourceId: source.id, zoom, x, y, ...size,
    configuredTileSize: source.tileSize, browserReadable: true,
    ...(size.width === source.tileSize ? {} : { message: `检测到 ${size.width} × ${size.height} 瓦片；请把图源瓦片尺寸改为 ${size.width} 后再规划下载。` }) };
}
