import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Local development only. The public site already serves /api/account on its own origin.
const hostname = "127.0.0.1";
const publicPort = Number(process.env.GEOD_PREVIEW_PORT || 3401);
const nextPort = Number(process.env.GEOD_FRONTEND_PORT || 3402);
const accountHost = "geod.laogao.xyz";
const localApi = process.env.GEOD_LOCAL_API_ORIGIN ? new URL(process.env.GEOD_LOCAL_API_ORIGIN) : null;
if (localApi && (localApi.protocol !== "http:" || localApi.hostname !== "127.0.0.1")) throw new Error("Local API must use HTTP loopback");
const websiteDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const allowedOrigin = `http://${hostname}:${publicPort}`;

function isAccountPath(requestUrl) {
  try {
    const pathname = new URL(requestUrl, allowedOrigin).pathname;
    return pathname === "/api/account" || pathname.startsWith("/api/account/") || pathname === "/api/geod-applications" || pathname.startsWith("/api/geod-applications/");
  } catch {
    return false;
  }
}

function reject(response, statusCode, code) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify({ error: { code } }));
}

function handleRequest(request, response) {
  if (request.headers.host !== `${hostname}:${publicPort}`) {
    reject(response, 400, "INVALID_HOST");
    return;
  }

  const accountRequest = isAccountPath(request.url);
  if (request.url.startsWith("/api/geod-applications") && !localApi) {
    reject(response, 503, "LOCAL_APPLICATION_API_REQUIRED");
    return;
  }
  if (accountRequest && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.origin !== allowedOrigin) {
    reject(response, 403, "ORIGIN_REJECTED");
    return;
  }

  const targetHeaders = { ...request.headers };
  let target;
  if (accountRequest && localApi) {
    targetHeaders.host = `${hostname}:${publicPort}`;
    target = http.request({ hostname:localApi.hostname, port:localApi.port, path:request.url, method:request.method, headers:targetHeaders, timeout:22000 });
  } else if (accountRequest) {
    targetHeaders.host = accountHost;
    targetHeaders.origin = `https://${accountHost}`;
    if (targetHeaders.referer?.startsWith(allowedOrigin)) {
      targetHeaders.referer = targetHeaders.referer.replace(allowedOrigin, `https://${accountHost}`);
    }
    target = https.request({
      hostname: accountHost,
      port: 443,
      path: request.url,
      method: request.method,
      headers: targetHeaders,
      timeout: 22000,
    });
  } else {
    targetHeaders.host = `${hostname}:${nextPort}`;
    target = http.request({
      hostname,
      port: nextPort,
      path: request.url,
      method: request.method,
      headers: targetHeaders,
    });
  }

  target.on("response", upstream => {
    const headers = { ...upstream.headers };
    if (accountRequest) {
      // Browsers cannot keep the production Secure cookie on this HTTP preview.
      // Remove only Secure, and only in this loopback development process.
      const cookies = headers["set-cookie"];
      if (cookies) headers["set-cookie"] = cookies.map(cookie => cookie.replace(/;\s*Secure(?=;|$)/gi, ""));
      headers["cache-control"] = "no-store";
    }
    response.writeHead(upstream.statusCode ?? 502, headers);
    upstream.pipe(response);
  });
  target.on("timeout", () => target.destroy(new Error("Account request timed out")));
  target.on("error", () => {
    if (!response.headersSent) reject(response, 502, accountRequest ? "ACCOUNT_UNAVAILABLE" : "PREVIEW_UNAVAILABLE");
    else response.destroy();
  });
  request.on("aborted", () => target.destroy());
  request.pipe(target);
}

const server = http.createServer(handleRequest);
server.on("upgrade", (request, socket, head) => {
  if (request.headers.host !== `${hostname}:${publicPort}` || isAccountPath(request.url)) {
    socket.destroy();
    return;
  }
  const upstream = net.connect(nextPort, hostname);
  upstream.on("connect", () => {
    const headers = request.rawHeaders.slice();
    for (let index = 0; index < headers.length; index += 2) {
      if (headers[index].toLowerCase() === "host") headers[index + 1] = `${hostname}:${nextPort}`;
      if (headers[index].toLowerCase() === "origin") headers[index + 1] = `http://${hostname}:${nextPort}`;
    }
    const lines = [`${request.method} ${request.url} HTTP/1.1`];
    for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(publicPort, hostname, () => {
  console.log(`GeoD local preview: ${allowedOrigin} (account API: ${localApi?.origin || accountHost})`);
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
