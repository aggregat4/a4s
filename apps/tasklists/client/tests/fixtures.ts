import { test as base, expect } from "@playwright/test";
import {
  isCssCoverageEnabled,
  startCssCoverage,
  stopCssCoverage,
  reportCssCoverageWarnings,
} from "./helpers/css-coverage";

const test = base.extend({
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
});

test.afterAll(() => {
  if (!isCssCoverageEnabled()) return;
  reportCssCoverageWarnings();
});

export { test, expect };
