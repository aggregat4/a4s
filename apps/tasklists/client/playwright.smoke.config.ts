import type { PlaywrightTestConfig } from "@playwright/test";
import baseConfig from "./playwright.config";

const config: PlaywrightTestConfig = {
  ...baseConfig,
  testMatch: ["cross-browser-smoke.spec.ts"],
  testIgnore: ["**/dist/**"],
  workers: 1,
  webServer: process.env.PLAYWRIGHT_EXTERNAL_SERVER ? undefined : baseConfig.webServer,
  projects: [
    { name: "firefox-smoke", use: { browserName: "firefox" } },
    {
      name: "mobile-webkit-smoke",
      use: {
        browserName: "webkit",
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
};

export default config;
