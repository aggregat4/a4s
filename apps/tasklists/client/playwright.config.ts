import type { PlaywrightTestConfig } from "@playwright/test";

const useGoServer = process.env.PLAYWRIGHT_USE_GO_SERVER === "1";
const useGoServerFullSuite = process.env.PLAYWRIGHT_GO_SERVER_FULL === "1";
const port = 8000;
const baseURL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://127.0.0.1:${port}`;

const dockerImage =
  process.env.PLAYWRIGHT_DOCKER_IMAGE ??
  "mcr.microsoft.com/playwright:v1.56.0-jammy";
const repositoryPath = process.cwd();
const useDockerServer = process.env.PLAYWRIGHT_USE_DOCKER === "1";
const goServerDockerImage = process.env.PLAYWRIGHT_GO_DOCKER_IMAGE ?? "golang:1.25-bookworm";
const webServerCommand = useGoServer
  ? useDockerServer
    ? `bash -lc "cd .. && PORT=${port} PLAYWRIGHT_GO_DOCKER_IMAGE=${goServerDockerImage} ./scripts/run-go-server-docker.sh"`
    : 'bash -lc "cd .. && rm -f ./server/test.db && SERVER_DB_PATH=./server/test.db exec ./scripts/run-local.sh"'
  : useDockerServer
      ? [
          "docker run --rm -i",
          `-p ${port}:${port}`,
          `-v "${repositoryPath}":/work`,
          "-w /work",
          dockerImage,
        `bash -lc "set -euxo pipefail; pwd; ls -la; npx http-server dist -p ${port} -c-1"`,
      ].join(" ")
    : `npx http-server dist -p ${port} -c-1`;

const config: PlaywrightTestConfig = {
  testDir: "tests",
  testIgnore: ["**/dist/**"],
  globalTeardown: "./tests/global-teardown.ts",
  ...(useGoServer && !useGoServerFullSuite
    ? { testMatch: ["**/sync-server.spec.ts"] }
    : {}),
  use: {
    baseURL,
  },

  // Automatically start a local HTTP server before tests
  webServer: {
    command: webServerCommand,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI && !useGoServer,
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
  ],
};

export default config;
