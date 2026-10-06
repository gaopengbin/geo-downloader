// Import approved public map examples into the official website's asset namespace.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const index = process.argv.indexOf("--source");
if (index < 0 || !process.argv[index + 1]) throw Error("Provide --source with the map product's public/geod directory");
const source = path.resolve(process.argv[index + 1]);
const website = path.resolve(__dirname, "..");
const catalogBytes = fs.readFileSync(path.join(source, "examples/catalog.json"));
const catalog = JSON.parse(catalogBytes);
const assetBytes = fs.readFileSync(path.join(source, "assets.json"));
const assets = JSON.parse(assetBytes);
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const output = path.join(website, "public/geod-site/maps");
fs.mkdirSync(output, { recursive: true });

function copyWebp(from, to, expectedHash) {
  const bytes = fs.readFileSync(path.join(source, from));
  if (bytes.length < 100 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") throw Error("Invalid map image: " + from);
  const sha256 = hash(bytes);
  if (expectedHash && sha256 !== expectedHash) throw Error("Map image changed: " + from);
  fs.writeFileSync(path.join(output, to), bytes);
  return { src: "/geod-site/maps/" + to, sha256 };
}

const hero = assets.assets.find(asset => asset.id === "studio-hero");
if (!hero) throw Error("Missing approved hero artwork");
const hidden = new Set(["beijing", "nepal-standard", "terrain-standard"]);
const selected = catalog.filter(example => example.category !== "模型对比" && !hidden.has(example.id)).slice(0, 6);
if (selected.length !== 6) throw Error("The map showcase needs six approved examples");
const examples = selected.map(example => {
  if (!/^[a-z0-9-]+$/.test(example.id)) throw Error("Unexpected example ID");
  const original = path.resolve(source, "examples", path.basename(example.image));
  if (hash(fs.readFileSync(original)) !== example.sha256) throw Error("Original example changed: " + example.id);
  return {
    id: example.id, title: example.title, category: example.category,
    description: example.description, width: example.width, height: example.height,
    originalSha256: example.sha256,
    ...copyWebp("thumbnails/" + example.id + ".webp", example.id + ".webp"),
  };
});
const manifest = {
  catalogSha256: hash(catalogBytes), assetsSha256: hash(assetBytes), newlyGeneratedImages: 0,
  hero: {
    ...copyWebp("studio-hero.webp", "studio-hero.webp", hero.outputSha256),
    width: hero.dimensions[0], height: hero.dimensions[1],
    attribution: hero.attribution, description: hero.description,
  },
  examples,
};
fs.writeFileSync(path.join(website, "src/lib/map-showcase.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("Imported 7 verified public map images; no new artwork or private files.");
