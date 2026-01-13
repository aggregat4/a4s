import { watch } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyStatic } from "./copy-static.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const watchedFiles = ["index.html", "styles.css"].map((file) =>
  resolve(root, file)
);
const watchedDirs = [
  resolve(root, "vendor"),
  resolve(root, "vendor", "directives"),
];

let pending = false;
const scheduleCopy = () => {
  if (pending) return;
  pending = true;
  setTimeout(async () => {
    pending = false;
    try {
      await copyStatic();
    } catch (err) {
      console.error("Static copy failed:", err);
    }
  }, 50);
};

await copyStatic();

const watchers = [];
for (const file of watchedFiles) {
  watchers.push(watch(file, scheduleCopy));
}
for (const dir of watchedDirs) {
  watchers.push(watch(dir, scheduleCopy));
}

const shutdown = () => {
  watchers.forEach((watcher) => watcher.close());
};

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});
