import { test as base, expect } from "@playwright/test";
import {
  isCssCoverageEnabled,
  startCssCoverage,
  stopCssCoverage,
  writeWorkerCssCoverage,
} from "./helpers/css-coverage";

// The dev-mode server keeps each user's data apart. Every test is its own
// user, so tests can run side by side, and the devices a test opens share
// that user's lists.
const devUserCookie = "a4_dev_user";

const test = base.extend<{}, { cssCoverageReport: void }>({
  storageState: async ({ baseURL }, use, testInfo) => {
    const user = `e2e-${testInfo.testId}-${testInfo.repeatEachIndex}-${testInfo.retry}`;
    await use({
      cookies: [
        {
          name: devUserCookie,
          value: user,
          domain: new URL(baseURL ?? "http://127.0.0.1").hostname,
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
  },
  page: async ({ page }, use, testInfo) => {
    const shouldTrack =
      isCssCoverageEnabled() && testInfo.project.name === "chromium";
    if (!shouldTrack) {
      await use(page);
      return;
    }
    const coverageSession = await startCssCoverage(page);
    await use(page);
    await stopCssCoverage(coverageSession.session, coverageSession.styleSheetIds);
  },
  cssCoverageReport: [
    async ({}, use, workerInfo) => {
      await use();
      writeWorkerCssCoverage(workerInfo.workerIndex);
    },
    { scope: "worker", auto: true },
  ],
});

export { test, expect };
