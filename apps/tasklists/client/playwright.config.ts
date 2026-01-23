import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL = `http://127.0.0.1:${port}`;
const webServerCommand = `bash -lc "cd .. && ./scripts/run-go-server-docker.sh"`;

const config: PlaywrightTestConfig = {
  testDir: "tests",
  testIgnore: ["**/dist/**"],
  globalTeardown: "./tests/global-teardown.ts",
  use: {
    baseURL,
  },

  // Automatically start a local HTTP server before tests
  webServer: {
    command: webServerCommand,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: false,
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
