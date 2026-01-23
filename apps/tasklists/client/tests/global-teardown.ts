import { execSync } from "node:child_process";

const containerName =
  process.env.PLAYWRIGHT_GO_SERVER_CONTAINER_NAME ??
  "prototype-lists-go-server";

export default async function globalTeardown() {
  if (process.env.PLAYWRIGHT_USE_GO_SERVER !== "1") return;
  if (process.env.PLAYWRIGHT_USE_DOCKER !== "1") return;
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {
    // Ignore cleanup failures.
  }
}
