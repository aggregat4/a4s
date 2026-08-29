import { spawn } from "node:child_process";

const processes = [
  spawn("npx", ["tsc", "-p", "tsconfig.app.json", "--noEmit", "-w"], {
    stdio: "inherit",
  }),
  spawn("node", ["tools/build/esbuild.mjs", "--watch"], {
    stdio: "inherit",
  }),
  spawn("npx", ["tsc", "-p", "tsconfig.tests.json", "-w"], {
    stdio: "inherit",
  }),
  spawn("node", ["tools/build/watch-static.mjs"], { stdio: "inherit" }),
];

const shutdown = () => {
  processes.forEach((proc) => proc.kill("SIGINT"));
};

process.on("SIGINT", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

process.on("exit", shutdown);
