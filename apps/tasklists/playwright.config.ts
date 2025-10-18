import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL =
  process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://127.0.0.1:${port}`;

const config: PlaywrightTestConfig = {
  use: {
    baseURL,
  },

  // Automatically start a local HTTP server before tests
  webServer: {
    command: `npx http-server . -p ${port} -c-1`,
    url: baseURL,
    timeout: 30_000,
    reuseExistingServer: !process.env.CI,
  },

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
};

export default config;
