import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL = `http://127.0.0.1:${port}`;

// The server runs natively: run-test-server.sh builds it with the local Go
// toolchain and starts it with a fresh database.
export const testServer = (mode: "dev" | "embedded" | "oidc", url = baseURL) => ({
  command: `bash ../scripts/run-test-server.sh ${mode}`,
  url,
  timeout: 120_000,
  reuseExistingServer: false,
});

// The node:test unit tests and the specs with configs of their own.
export const ignored = [
  "**/dist/**",
  "unit/**",
  "oidc.spec.ts",
  "cross-browser-smoke.spec.ts",
  "embedded-static.spec.ts",
];

const config: PlaywrightTestConfig = {
  testDir: "tests",
  testIgnore: ignored,
  // Each test signs in as a user of its own (see tests/fixtures.ts), so tests
  // do not share data and can all run in parallel.
  fullyParallel: true,
  globalSetup: "./tests/global-setup.ts",
  globalTeardown: "./tests/global-teardown.ts",
  use: {
    baseURL,
    // A step waiting for an element that never comes fails instead of
    // waiting until the test times out.
    actionTimeout: 15_000,
    // CI uploads test-results when a run fails; a trace shows the page and
    // its console step by step.
    trace: process.env.CI ? "retain-on-failure" : "off",
  },

  webServer: testServer("dev"),

  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
};

export default config;
