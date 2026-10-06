import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createPreviewServer } from "./preview-proxy.mjs";

const servers = [];
let origin, appOrigin, localOrigin;
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function proxyOrigin(options) {
  const placeholder = http.createServer();
  const address = await listen(placeholder);
  await new Promise(resolve => placeholder.close(resolve));
  const proxy = createPreviewServer({ ...options, previewOrigin: address });
  await new Promise(resolve => proxy.listen(new URL(address).port, "127.0.0.1", resolve));
  servers.push(proxy);
  return address;
}
function fixture(name) {
  return http.createServer((request, response) => {
    if (name === "website" && request.url.includes("missing-map.js")) { response.writeHead(404); return response.end(); }
    if (name === "website" && request.url.includes("broken.js")) { response.writeHead(503); return response.end("local failure"); }
    if (name === "studio" && request.url === "/geod/gallery/redirect") {
      response.writeHead(302, {
        location: `${appOrigin}/geod/examples/nepal-sandtable?from=gallery#image`,
        "set-cookie": "fixture=ok; Domain=127.0.0.1; Path=/; Secure; HttpOnly; SameSite=Lax",
      });
      return response.end();
    }
    if (name === "studio" && request.url === "/geod/gallery/oauth") {
      response.writeHead(302, { location: "http://127.0.0.1:50999/callback?code=fixture" });
      return response.end();
    }
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      response.writeHead(200, { "content-type": request.headers.rsc ? "text/x-component" : "application/json" });
      response.end(JSON.stringify({ name, path: request.url, headers: request.headers, body: Buffer.concat(chunks).toString() }));
    });
  });
}
before(async () => {
  localOrigin = await listen(fixture("website"));
  appOrigin = await listen(fixture("studio"));
  origin = await proxyOrigin({ frontendOrigin: localOrigin, applicationOrigin: appOrigin });
});
after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
});

test("secondary pages, public media and their API stay behind the preview origin", async () => {
  for (const path of ["/geod/examples", "/geod/examples/nepal-sandtable", "/geod/gallery", "/geod/workspace?credits=1", "/geod/fonts/font.woff2", "/geod-app/version/geod/data/cli/region.geojson", "/api/geod-studio/gallery"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.name, "studio");
    assert.equal(data.path, path);
  }
  for (const path of ["/", "/geod", "/dashboard", "/geod-site/maps/studio-hero.webp", "/api/accounting", "/geod/gallery-other"]) {
    assert.equal((await (await fetch(`${origin}${path}`)).json()).name, "website");
  }
});

test("shared assets fall back only on local 404 and preserve other errors", async () => {
  const existing = await (await fetch(`${origin}/_next/static/website.js`)).json();
  assert.equal(existing.name, "website");
  const missing = await (await fetch(`${origin}/_next/static/missing-map.js?version=1`)).json();
  assert.equal(missing.name, "studio");
  assert.equal(missing.path, "/_next/static/missing-map.js?version=1");
  const broken = await fetch(`${origin}/_next/static/broken.js`);
  assert.equal(broken.status, 503);
  assert.equal(await broken.text(), "local failure");
});

test("cross-app navigation uses HTML while navigation inside each app retains Flight", async () => {
  for (const [destination, source] of [["/geod", "/geod/gallery"], ["/geod/workspace", "/geod"]]) {
    const response = await fetch(`${origin}${destination}?_rsc=fixture`, { headers: { rsc: "1", "next-router-state-tree": "fixture", referer: `${origin}${source}` } });
    assert.notEqual(response.headers.get("content-type"), "text/x-component");
    const data = await response.json();
    assert.equal(data.headers.rsc, undefined);
    assert.equal(data.headers["next-router-state-tree"], undefined);
  }
  for (const [destination, source] of [["/dashboard", "/geod"], ["/geod/examples", "/geod/gallery"]]) {
    const response = await fetch(`${origin}${destination}`, { headers: { rsc: "1", referer: `${origin}${source}` } });
    assert.equal(response.headers.get("content-type"), "text/x-component");
  }
});

test("the retired CLI experience redirects to browser imagery", async () => {
  for (const path of ["/geod/cli", "/geod/cli/?old=1"]) {
    const response = await fetch(`${origin}${path}`, { redirect: "manual" });
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "/browser");
  }
});

test("official account and map requests forward the same session cookie", async () => {
  const cookie = "geostyle_session=fixture-session-only";
  for (const path of ["/api/account", "/geod/workspace", "/api/geod-studio/projects"]) {
    const response = await fetch(`${origin}${path}`, { headers: { cookie } });
    const data = await response.json();
    assert.equal(data.name, "studio");
    assert.equal(data.headers.cookie, cookie);
  }
});

test("canonical redirects stay local, OAuth callbacks stay intact, cookies retain protection", async () => {
  const response = await fetch(`${origin}/geod/gallery/redirect`, { redirect: "manual" });
  assert.equal(response.headers.get("location"), "/geod/examples/nepal-sandtable?from=gallery#image");
  assert.equal(response.headers.get("set-cookie"), "fixture=ok; Path=/; HttpOnly; SameSite=Lax");
  const oauth = await fetch(`${origin}/geod/gallery/oauth`, { redirect: "manual" });
  assert.equal(oauth.headers.get("location"), "http://127.0.0.1:50999/callback?code=fixture");
});

test("API writes require the preview origin and forward body with canonical identity", async () => {
  const rejected = await fetch(`${origin}/api/geod-studio/plan`, { method: "POST", body: "fixture", headers: { origin: "https://other.invalid" } });
  assert.equal(rejected.status, 403);
  const response = await fetch(`${origin}/api/geod-studio/plan`, { method: "POST", body: "fixture", headers: { origin, referer: `${origin}/geod/workspace`, "x-forwarded-host": "other.invalid" } });
  const data = await response.json();
  assert.equal(data.body, "fixture");
  assert.equal(data.headers.origin, appOrigin);
  assert.equal(data.headers.referer, `${appOrigin}/geod/workspace`);
  assert.equal(data.headers["x-forwarded-host"], undefined);
  const intake = await fetch(`${origin}/api/geod-applications`, { method: "POST", headers: { origin } });
  assert.equal(intake.status, 503);
});

test("a fixture account cannot mutate the production map service", async () => {
  const isolated = await proxyOrigin({ frontendOrigin: localOrigin, applicationOrigin: "https://geod.laogao.xyz", localApiOrigin: localOrigin });
  const response = await fetch(`${isolated}/api/geod-studio/plan`, { method: "POST", headers: { origin: isolated } });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "LOCAL_STUDIO_API_REQUIRED");
  const account = await fetch(`${isolated}/api/account/login`, { method: "POST", body: "fixture", headers: { origin: isolated } });
  const data = await account.json();
  assert.equal(data.name, "website");
  assert.equal(data.headers.host, new URL(isolated).host);
  assert.equal(data.headers.origin, isolated);
  assert.equal(data.body, "fixture");
});
