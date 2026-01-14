import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const distRoot = resolve(root, "dist");

export async function copyStatic() {
  await mkdir(distRoot, { recursive: true });
  await cp(resolve(root, "public", "index.html"), resolve(distRoot, "index.html"));
  await cp(resolve(root, "public", "styles.css"), resolve(distRoot, "styles.css"));
  await cp(resolve(root, "src", "vendor"), resolve(distRoot, "vendor"), {
    recursive: true,
  });
  await writeFile(
    resolve(distRoot, "package.json"),
    JSON.stringify({ type: "module" }, null, 2)
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await copyStatic();
}
