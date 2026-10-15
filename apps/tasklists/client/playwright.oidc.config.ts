import type { PlaywrightTestConfig } from "@playwright/test";
import baseConfig, { testServer } from "./playwright.config";

// Runs the OIDC + service worker browser tests against a server configured with
// the in-repo mock OpenID Provider. Kept separate from the default config so the
// dev-auth browser suite stays fast.
const config: PlaywrightTestConfig = {
  ...baseConfig,
  testMatch: ["oidc.spec.ts"],
  testIgnore: ["**/dist/**"],
  globalSetup: undefined,
  globalTeardown: undefined,
  webServer: testServer("oidc", "http://127.0.0.1:8000/healthz"),
};

export default config;
