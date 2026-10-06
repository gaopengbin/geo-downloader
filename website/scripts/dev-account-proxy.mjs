import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer } from "./preview-proxy.mjs";

// Development only: the public site routes these services through Nginx.
const hostname = "127.0.0.1";
const publicPort = Number(process.env.GEOD_PREVIEW_PORT || 3401);
const nextPort = Number(process.env.GEOD_FRONTEND_PORT || 3402);
const applicationOrigin = process.env.GEOD_STUDIO_ORIGIN || "https://geod.laogao.xyz";
const localApiOrigin = process.env.GEOD_LOCAL_API_ORIGIN || null;
for (const origin of [localApiOrigin, process.env.GEOD_STUDIO_ORIGIN].filter(Boolean)) {
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== hostname) throw new Error("Local services must use HTTP loopback");
}
const websiteDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const previewOrigin = `http://${hostname}:${publicPort}`;
const server = createPreviewServer({ previewOrigin, frontendOrigin: `http://${hostname}:${nextPort}`, applicationOrigin, localApiOrigin });

server.listen(publicPort, hostname, () => {
  console.log(`GeoD local preview: ${previewOrigin} (account: ${localApiOrigin || applicationOrigin}; map app: ${applicationOrigin})`);
  const next = spawn(process.execPath, [path.join(websiteDirectory, "node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(nextPort), "-H", hostname], {
    cwd: websiteDirectory,
    stdio: "inherit",
    windowsHide: true,
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    next.kill();
    server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  next.on("exit", code => {
    if (!stopping) {
      server.close();
      process.exitCode = code || 1;
    }
  });
});
server.on("error", error => {
  console.error(`Local preview could not start: ${error.message}`);
  process.exitCode = 1;
});
