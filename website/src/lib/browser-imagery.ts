export type Bounds = [number, number, number, number];

export type ImageryPlan = {
  bounds: Bounds;
  zoom: number;
  firstX: number;
  lastX: number;
  firstY: number;
  lastY: number;
  tiles: number;
  width: number;
  height: number;
  westPixel: number;
  northPixel: number;
  source: string;
  attribution: string;
};

const TILE_SIZE = 256;
const MAX_LAT = 85.05112878;
const MAX_TILES = 256;
const MAX_PIXELS = 16_777_216;
const EARTH_RADIUS = 6_378_137;

export const BROWSER_SOURCE = {
  name: "NASA GIBS Blue Marble Shaded Relief Bathymetry",
  attribution: "NASA GIBS / Blue Marble；地形概览图，不是近期卫星影像",
  tileUrl: (zoom: number, x: number, y: number) =>
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/${zoom}/${y}/${x}.jpeg`,
};

function longitudePixel(longitude: number, zoom: number) {
  return ((longitude + 180) / 360) * TILE_SIZE * 2 ** zoom;
}

function latitudePixel(latitude: number, zoom: number) {
  const radians = (latitude * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * TILE_SIZE * 2 ** zoom;
}

export function planBrowserImagery(bounds: Bounds, zoom: number): ImageryPlan {
  if (!Array.isArray(bounds) || bounds.length !== 4 || bounds.some(value => !Number.isFinite(value))) {
    throw new Error("请输入有效的西、南、东、北经纬度。");
  }
  const [west, south, east, north] = bounds;
  if (west < -180 || east > 180 || west >= east || south < -MAX_LAT || north > MAX_LAT || south >= north) {
    throw new Error("范围需为 WGS84 经纬度，且满足西 < 东、南 < 北；跨 180° 经线请拆成两个任务。");
  }
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > 8) {
    throw new Error("当前 NASA 图源支持 0–8 级。");
  }
  const maxIndex = 2 ** zoom - 1;
  const westPixel = longitudePixel(west, zoom);
  const eastPixel = longitudePixel(east, zoom);
  const northPixel = latitudePixel(north, zoom);
  const southPixel = latitudePixel(south, zoom);
  const firstX = Math.max(0, Math.floor(westPixel / TILE_SIZE));
  const lastX = Math.min(maxIndex, Math.ceil(eastPixel / TILE_SIZE) - 1);
  const firstY = Math.max(0, Math.floor(northPixel / TILE_SIZE));
  const lastY = Math.min(maxIndex, Math.ceil(southPixel / TILE_SIZE) - 1);
  const width = Math.ceil(eastPixel - westPixel);
  const height = Math.ceil(southPixel - northPixel);
  const tiles = (lastX - firstX + 1) * (lastY - firstY + 1);
  if (width < 1 || height < 1) throw new Error("范围过小，请扩大范围或提高级别。");
  if (tiles > MAX_TILES || width * height > MAX_PIXELS) {
    throw new Error(`本机浏览器单次最多 ${MAX_TILES} 块瓦片、约 1600 万像素；请缩小范围或降低级别。`);
  }
  return {
    bounds, zoom, firstX, lastX, firstY, lastY, tiles, width, height,
    westPixel, northPixel, source: BROWSER_SOURCE.name, attribution: BROWSER_SOURCE.attribution,
  };
}

function mercatorX(longitude: number) {
  return EARTH_RADIUS * longitude * Math.PI / 180;
}

function mercatorY(latitude: number) {
  const radians = latitude * Math.PI / 180;
  return EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + radians / 2));
}

function worldFile(plan: ImageryPlan) {
  const [west, south, east, north] = plan.bounds;
  const pixelX = (mercatorX(east) - mercatorX(west)) / plan.width;
  const pixelY = (mercatorY(south) - mercatorY(north)) / plan.height;
  return [pixelX, 0, 0, pixelY, mercatorX(west) + pixelX / 2, mercatorY(north) + pixelY / 2]
    .map(value => value.toFixed(12)).join("\n") + "\n";
}

const WEB_MERCATOR_WKT = 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3857"]]\n';

function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++) {
    crc ^= data[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function makeZip(files: { name: string; data: Uint8Array }[]) {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const checksum = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const head = new DataView(local.buffer);
    head.setUint32(0, 0x04034b50, true);
    head.setUint16(4, 20, true);
    head.setUint16(26, name.length, true);
    head.setUint32(14, checksum, true);
    head.setUint32(18, file.data.length, true);
    head.setUint32(22, file.data.length, true);
    local.set(name, 30);
    parts.push(local, file.data);
    const central = new Uint8Array(46 + name.length);
    const entry = new DataView(central.buffer);
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint32(16, checksum, true);
    entry.setUint32(20, file.data.length, true);
    entry.setUint32(24, file.data.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.set(name, 46);
    directory.push(central);
    offset += local.length + file.data.length;
  }
  const directorySize = directory.reduce((total, part) => total + (part as Uint8Array).length, 0);
  const end = new Uint8Array(22);
  const footer = new DataView(end.buffer);
  footer.setUint32(0, 0x06054b50, true);
  footer.setUint16(8, files.length, true);
  footer.setUint16(10, files.length, true);
  footer.setUint32(12, directorySize, true);
  footer.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}

export async function downloadBrowserImagery(
  plan: ImageryPlan,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw new DOMException("任务已取消。", "AbortError");
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener("abort", relayAbort, { once: true });
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("浏览器无法创建影像画布。");
  const jobs: { x: number; y: number }[] = [];
  for (let y = plan.firstY; y <= plan.lastY; y++) {
    for (let x = plan.firstX; x <= plan.lastX; x++) jobs.push({ x, y });
  }
  let next = 0;
  let done = 0;
  onProgress(0, jobs.length);
  async function worker() {
    while (next < jobs.length) {
      if (signal?.aborted) throw new DOMException("任务已取消。", "AbortError");
      const { x, y } = jobs[next++];
      const response = await fetch(BROWSER_SOURCE.tileUrl(plan.zoom, x, y), { mode: "cors", signal: controller.signal });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("image/")) {
        throw new Error(`图源瓦片 ${plan.zoom}/${x}/${y} 获取失败（HTTP ${response.status}）。`);
      }
      const bitmap = await createImageBitmap(await response.blob());
      if (bitmap.width !== TILE_SIZE || bitmap.height !== TILE_SIZE) {
        bitmap.close();
        throw new Error(`图源瓦片 ${plan.zoom}/${x}/${y} 尺寸异常。`);
      }
      context!.drawImage(bitmap, x * TILE_SIZE - plan.westPixel, y * TILE_SIZE - plan.northPixel);
      bitmap.close();
      onProgress(++done, jobs.length);
      if (done % 4 === 0) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, () => worker()));
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    signal?.removeEventListener("abort", relayAbort);
  }
  if (signal?.aborted) throw new DOMException("任务已取消。", "AbortError");
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG 导出失败。")), "image/png");
  });
  const encoder = new TextEncoder();
  const manifest = {
    schemaVersion: "geod-browser-1", generatedAt: new Date().toISOString(),
    bounds: plan.bounds, crs: "EPSG:3857", zoom: plan.zoom,
    width: plan.width, height: plan.height, tileCount: plan.tiles,
    source: plan.source, attribution: plan.attribution,
    files: ["imagery.png", "imagery.pgw", "imagery.prj"],
    note: "NASA Blue Marble 地形概览图，不代表近期卫星拍摄时间。影像由当前浏览器直接下载和拼接，未上传到 GeoD 服务器。",
  };
  const zip = makeZip([
    { name: "imagery.png", data: new Uint8Array(await png.arrayBuffer()) },
    { name: "imagery.pgw", data: encoder.encode(worldFile(plan)) },
    { name: "imagery.prj", data: encoder.encode(WEB_MERCATOR_WKT) },
    { name: "manifest.json", data: encoder.encode(JSON.stringify(manifest, null, 2)) },
  ]);
  return { png, zip, manifest };
}
