import { readdir, stat, writeFile } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const distRoot = resolve(root, "dist");
const outputPath = resolve(distRoot, "asset-manifest.json");

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(fullPath);
    } else {
      yield fullPath;
    }
  }
}

async function generate() {
  const assets = [];
  for await (const fullPath of walk(distRoot)) {
    const relPath = "/" + relative(distRoot, fullPath).split(sep).join("/");
    if (relPath === "/asset-manifest.json") continue;
    if (relPath === "/package.json") continue;
    if (relPath.startsWith("/tests/")) continue;
    if (relPath.startsWith("/src/")) continue;
    if (relPath.startsWith("/playwright.config")) continue;
    assets.push(relPath);
  }
  assets.sort();
  await writeFile(outputPath, JSON.stringify(assets, null, 2));
  console.log(`asset-manifest.json: ${assets.length} assets`);
}

await generate();
