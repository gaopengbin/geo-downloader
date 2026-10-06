const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/lib/map-showcase.json")));
if (manifest.examples.length !== 6 || manifest.newlyGeneratedImages !== 0) throw Error("Unexpected map showcase");
for (const image of [manifest.hero, ...manifest.examples]) {
  if (!/^\/geod-site\/maps\/[a-z0-9-]+\.webp$/.test(image.src)) throw Error("Unexpected public map image URL");
  const bytes = fs.readFileSync(path.join(root, "public", image.src));
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP" || crypto.createHash("sha256").update(bytes).digest("hex") !== image.sha256) throw Error("Missing or changed map image: " + image.src);
}
console.log("7 official-site map images passed content and SHA-256 checks.");
