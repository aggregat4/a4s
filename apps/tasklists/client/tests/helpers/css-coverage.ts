import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";
import postcss, { type AtRule, type Rule } from "postcss";

// Tracks which rules of styles.css the browser tests exercise. Tests run in
// several worker processes, so each worker writes what it saw to a directory
// that global setup creates, and global teardown merges and reports it.

// Chromium reports only the rules it used, so the full list of rules comes
// from parsing the stylesheet the browser loaded.
type WorkerCoverage = {
  cssText: string | null;
  usedOffsets: number[];
};

const coverageDirEnv = "A4_CSS_COVERAGE_DIR";

let cssText: string | null = null;
const usedOffsets = new Set<number>();

const stylesUrlSuffix = "/styles.css";

function shouldTrackSheet(sourceURL?: string) {
  if (!sourceURL) return false;
  return sourceURL.endsWith(stylesUrlSuffix);
}

// Nested rules read as "&:hover", so name the rules they sit in.
function describeRule(rule: Rule) {
  const selectors = [];
  for (let node: Rule["parent"] = rule; node && node.type !== "root"; node = node.parent) {
    if (node.type === "rule") selectors.unshift((node as Rule).selector.replace(/\s+/g, " "));
  }
  return selectors.join(" → ");
}

export function isCssCoverageEnabled() {
  return Boolean(process.env[coverageDirEnv]);
}

export async function startCssCoverage(page: Page) {
  const session = await page.context().newCDPSession(page);
  const styleSheetIds = new Set<string>();
  session.on("CSS.styleSheetAdded", (event) => {
    if (shouldTrackSheet(event.header?.sourceURL)) {
      styleSheetIds.add(event.header.styleSheetId);
    }
  });
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  await session.send("CSS.startRuleUsageTracking");
  return { session, styleSheetIds };
}

export async function stopCssCoverage(
  session: CDPSession,
  styleSheetIds: Set<string>
) {
  const { ruleUsage } = await session.send("CSS.stopRuleUsageTracking");
  for (const styleSheetId of styleSheetIds) {
    const relevantUsage = ruleUsage.filter(
      (usage) => usage.styleSheetId === styleSheetId && usage.used
    );
    if (relevantUsage.length === 0) continue;
    // Every page loads the same styles.css, so a rule is known by its offset.
    if (cssText === null) {
      ({ text: cssText } = await session.send("CSS.getStyleSheetText", {
        styleSheetId,
      }));
    }
    for (const usage of relevantUsage) {
      usedOffsets.add(usage.startOffset);
    }
  }
  await session.detach();
}

/** Writes what this worker saw; called once when the worker shuts down. */
export function writeWorkerCssCoverage(workerIndex: number) {
  const dir = process.env[coverageDirEnv];
  if (!dir || cssText === null) return;
  const coverage: WorkerCoverage = { cssText, usedOffsets: [...usedOffsets] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `worker-${workerIndex}-${process.pid}.json`), JSON.stringify(coverage));
}

export function setupCssCoverage() {
  process.env[coverageDirEnv] = mkdtempSync(join(tmpdir(), "a4-tasklists-css-coverage-"));
}

export function reportCssCoverage() {
  const dir = process.env[coverageDirEnv];
  if (!dir) return;
  let text: string | null = null;
  const used = new Set<number>();
  for (const file of readdirSync(dir)) {
    const coverage = JSON.parse(readFileSync(join(dir, file), "utf8")) as WorkerCoverage;
    text ??= coverage.cssText;
    for (const offset of coverage.usedOffsets) used.add(offset);
  }
  rmSync(dir, { recursive: true, force: true });
  if (text === null) return;

  const unused: Rule[] = [];
  let total = 0;
  postcss.parse(text).walkRules((rule) => {
    // Keyframe steps are not style rules, and Chromium never reports them.
    if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as AtRule).name)) {
      return;
    }
    total += 1;
    if (!used.has(rule.source?.start?.offset ?? -1)) unused.push(rule);
  });
  if (unused.length === 0) {
    console.warn(`[css-coverage] All ${total} rules in styles.css were exercised.`);
    return;
  }
  console.warn(
    `[css-coverage] ${unused.length} of ${total} rules in styles.css were never used:`
  );
  for (const rule of unused) {
    console.warn(`[css-coverage] - styles.css:${rule.source?.start?.line} ${describeRule(rule)}`);
  }
}
