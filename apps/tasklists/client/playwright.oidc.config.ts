import type { PlaywrightTestConfig } from "@playwright/test";

const port = 8000;
const baseURL = `http://127.0.0.1:${port}`;
const webServerCommand = `bash -lc "cd .. && ./scripts/run-go-server-oidc-docker.sh"`;

// Runs the OIDC + service worker browser tests against a server configured with
// the in-repo mock OpenID Provider. Kept separate from the default config so the
// dev-auth browser suite stays fast.
const config: PlaywrightTestConfig = {
  testDir: "tests",
  testMatch: ["oidc.spec.ts"],
  globalTeardown: "./tests/global-teardown.ts",
  use: {
    baseURL,
  },
  webServer: {
    command: webServerCommand,
    url: `${baseURL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
};

export default config;
