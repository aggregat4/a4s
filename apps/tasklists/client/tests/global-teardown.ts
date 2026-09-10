import { execSync } from "node:child_process";

const containerNames = [
  "a4-tasklists-go-server",
  "a4-tasklists-oidc-server",
];

export default async function globalTeardown() {
  for (const containerName of containerNames) {
    try {
      execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
    } catch {
      // Ignore cleanup failures.
    }
  }
}
