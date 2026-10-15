import type { PlaywrightTestConfig } from "@playwright/test";
import baseConfig, { testServer } from "./playwright.config";

// Serves the client from files embedded in the server binary.
const config: PlaywrightTestConfig = {
  ...baseConfig,
  testMatch: ["embedded-static.spec.ts"],
  testIgnore: ["**/dist/**"],
  globalSetup: undefined,
  globalTeardown: undefined,
  webServer: testServer("embedded"),
};

export default config;
