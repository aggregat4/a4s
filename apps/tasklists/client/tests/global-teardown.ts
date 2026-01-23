import { execSync } from "node:child_process";

const containerName = "prototype-lists-go-server";

export default async function globalTeardown() {
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {
    // Ignore cleanup failures.
  }
}
