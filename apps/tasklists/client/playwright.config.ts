import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL = `http://127.0.0.1:${port}`;
const webServerCommand = `bash -lc "cd .. && ./scripts/run-go-server-docker.sh"`;
const ignored = ["**/dist/**", "oidc.spec.ts", "cross-browser-smoke.spec.ts"];
// These specs share the sync server's data, which sync-server.spec.ts resets
// before each test, so they run one at a time, beside the other specs.
const syncServerSpecs = ["sync-server.spec.ts", "ui-model.spec.ts"];

const config: PlaywrightTestConfig = {
  testDir: "tests",
  testIgnore: ignored,
  globalTeardown: "./tests/global-teardown.ts",
  use: {
    baseURL,
  },

  // Automatically start a local HTTP server before tests
  webServer: {
    command: webServerCommand,
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: false,
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
      testIgnore: [...ignored, ...syncServerSpecs],
    },
    {
      name: "chromium-sync",
      use: { browserName: "chromium" },
      testMatch: syncServerSpecs,
      testIgnore: ignored,
      workers: 1,
    },
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
  ],
};

export default config;
