import { build, context } from "esbuild";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = resolve(root, "dist");
const entryPoints = {
  "entrypoints/main": resolve(root, "src", "entrypoints", "main.ts"),
  "entrypoints/demo-seeds": resolve(root, "src", "entrypoints", "demo-seeds.ts"),
};

const options = {
  entryPoints,
  outdir: distRoot,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2020",
  sourcemap: true,
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
};

const watch = process.argv.includes("--watch");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("esbuild: watching for changes...");
} else {
  await build(options);
}
