import http from "node:http";
import https from "node:https";
import net from "node:net";

const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const beneath = (pathname, prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function previewRoute(pathname) {
  if (beneath(pathname, "/geod/cli")) return "retired-cli";
  if (beneath(pathname, "/api/account")) return "account";
  if (beneath(pathname, "/api/geod-applications")) return "applications";
  if (beneath(pathname, "/api/geod-studio") || beneath(pathname, "/api/background-runs")) return "studio-api";
  if (["/geod/gallery", "/geod/examples", "/geod/workspace"].some(prefix => beneath(pathname, prefix))) return "studio-page";
  if (["/geod/fonts", "/geod/styles", "/geod/data", "/geod/thumbnails", "/geod-app"].some(prefix => beneath(pathname, prefix)) || ["/geod/studio-hero.webp", "/geod/assets.json", "/_next/image"].includes(pathname)) return "studio-asset";
  if (pathname.startsWith("/_next/static/")) return "shared-asset";
  return "website";
}

export function createPreviewServer({ previewOrigin, frontendOrigin, applicationOrigin, localApiOrigin = null }) {
  const preview = new URL(previewOrigin);
  const frontend = new URL(frontendOrigin);
  const application = new URL(applicationOrigin);
  const localApi = localApiOrigin ? new URL(localApiOrigin) : null;

  function reject(response, status, code) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: { code } }));
  }

  const server = http.createServer((request, response) => {
    if (request.headers.host !== preview.host) return reject(response, 400, "INVALID_HOST");
    let url;
    try { url = new URL(request.url, preview); } catch { return reject(response, 400, "INVALID_PATH"); }
    if (url.origin !== preview.origin) return reject(response, 400, "INVALID_PATH");
    const route = previewRoute(url.pathname);
    if (route === "retired-cli") {
      response.writeHead(307, { location: "/browser", "cache-control": "no-store" });
      return response.end();
    }
    const apiRequest = ["account", "applications", "studio-api"].includes(route);
    const studioRequest = route.startsWith("studio-");
    const localApplication = application.protocol === "http:" && application.hostname === "127.0.0.1";
    if (route === "applications" && !localApi) return reject(response, 503, "LOCAL_APPLICATION_API_REQUIRED");
    // A fixture account must never be used to write to the production map service.
    if (route === "studio-api" && localApi && !localApplication && !readMethods.has(request.method)) return reject(response, 503, "LOCAL_STUDIO_API_REQUIRED");
    if (apiRequest && !readMethods.has(request.method) && request.headers.origin !== preview.origin) return reject(response, 403, "ORIGIN_REJECTED");

    let activeTarget;
    request.on("aborted", () => activeTarget?.destroy());
    response.on("close", () => { if (!response.writableFinished) activeTarget?.destroy(); });

    function forward(destination, allowAssetFallback = false, body = true) {
      const headers = { ...request.headers, host: destination.host };
      // Local account fixtures validate against the public preview Host/Origin.
      if (apiRequest && destination.origin === localApi?.origin) headers.host = preview.host;
      // Do not pass client-supplied proxy identity headers to either service.
      for (const key of Object.keys(headers)) if (key === "forwarded" || key.startsWith("x-forwarded-")) delete headers[key];
      const remote = destination.origin !== frontend.origin && destination.origin !== localApi?.origin;
      if (remote) {
        if (headers.origin) headers.origin = destination.origin;
        if (headers.referer?.startsWith(`${preview.origin}/`)) headers.referer = headers.referer.replace(preview.origin, destination.origin);
      }

      // The website and map app use different Next versions. Crossing their
      // boundary must load a document, rather than incompatible Flight data.
      let fromStudio = false;
      try {
        const referrer = new URL(request.headers.referer);
        fromStudio = referrer.origin === preview.origin && previewRoute(referrer.pathname) === "studio-page";
      } catch { /* A document request need not have a referrer. */ }
      if (headers.rsc && ((route === "studio-page" && !fromStudio) || (route === "website" && fromStudio))) {
        for (const key of ["rsc", "next-router-state-tree", "next-router-prefetch", "next-router-segment-prefetch", "next-url"]) delete headers[key];
        headers.accept = "text/html";
      }

      const transport = destination.protocol === "https:" ? https : http;
      const target = transport.request({
        hostname: destination.hostname,
        port: destination.port || (destination.protocol === "https:" ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: request.method,
        headers,
        timeout: apiRequest ? 120000 : 22000,
      });
      activeTarget = target;
      target.on("response", upstream => {
        // Hashed map-app chunks share /_next/static with the local website.
        // Only a missing local asset may fall back; never mask other failures.
        if (allowAssetFallback && upstream.statusCode === 404 && ["GET", "HEAD"].includes(request.method)) {
          upstream.resume();
          forward(application, false, false);
          return;
        }
        const responseHeaders = { ...upstream.headers };
        if (remote || (apiRequest && localApi)) {
          if (responseHeaders.location) {
            try {
              const location = new URL(responseHeaders.location, destination);
              if (location.origin === destination.origin) responseHeaders.location = `${location.pathname}${location.search}${location.hash}`;
            } catch { /* Preserve unrelated redirects, including OAuth callbacks. */ }
          }
          if (responseHeaders["set-cookie"]) responseHeaders["set-cookie"] = responseHeaders["set-cookie"].map(cookie => {
            let localCookie = cookie.replace(/;\s*Secure(?=;|$)/gi, "");
            localCookie = localCookie.replace(/;\s*Domain=\.?([^;]+)/gi, (attribute, domain) => domain.toLowerCase() === destination.hostname.toLowerCase() ? "" : attribute);
            return localCookie;
          });
        }
        if (apiRequest || route === "studio-page") responseHeaders["cache-control"] = "no-store";
        response.writeHead(upstream.statusCode ?? 502, responseHeaders);
        upstream.on("error", () => response.destroy());
        upstream.pipe(response);
      });
      target.on("timeout", () => target.destroy(new Error("Preview upstream timed out")));
      target.on("error", () => {
        if (!response.headersSent) reject(response, 502, apiRequest ? "API_UNAVAILABLE" : "PREVIEW_UNAVAILABLE");
        else response.destroy();
      });
      if (body) request.pipe(target);
      else target.end();
    }

    const destination = (route === "account" || route === "applications") ? (localApi || application) : studioRequest ? application : frontend;
    forward(destination, route === "shared-asset");
  });

  server.on("upgrade", (request, socket, head) => {
    if (request.headers.host !== preview.host || !request.url.startsWith("/_next/webpack-hmr")) return socket.destroy();
    const upstream = net.connect(Number(frontend.port), frontend.hostname);
    upstream.on("connect", () => {
      const headers = request.rawHeaders.slice();
      for (let index = 0; index < headers.length; index += 2) {
        if (headers[index].toLowerCase() === "host") headers[index + 1] = frontend.host;
        if (headers[index].toLowerCase() === "origin") headers[index + 1] = frontend.origin;
      }
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
  });
  return server;
}
