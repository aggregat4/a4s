import { rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
await rm(resolve(root, "dist"), {
  recursive: true,
  force: true,
});
