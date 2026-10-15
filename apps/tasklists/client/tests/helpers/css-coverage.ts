import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "@playwright/test";

// Tracks which rules of styles.css the browser tests exercise. Tests run in
// several worker processes, so each worker writes what it saw to a directory
// that global setup creates, and global teardown merges and reports it.

type RuleKey = string;

type RuleRecord = {
  startOffset: number;
  endOffset: number;
  selector: string;
};

type WorkerCoverage = {
  rules: [RuleKey, RuleRecord][];
  used: RuleKey[];
};

const coverageDirEnv = "A4_CSS_COVERAGE_DIR";

const allRules = new Map<RuleKey, RuleRecord>();
const usedRules = new Set<RuleKey>();

const stylesUrlSuffix = "/styles.css";

// Every page loads the same styles.css, so a rule is known by its offsets.
function getRuleKey(startOffset: number, endOffset: number) {
  return `${startOffset}:${endOffset}`;
}

function extractSelector(ruleText: string) {
  const braceIndex = ruleText.indexOf("{");
  const selectorText = braceIndex === -1 ? ruleText : ruleText.slice(0, braceIndex);
  return selectorText.replace(/\s+/g, " ").trim();
}

function formatRuleSnippet(rule: RuleRecord) {
  const selector = rule.selector || "<unknown selector>";
  return `${selector} (offsets ${rule.startOffset}-${rule.endOffset})`;
}

function shouldTrackSheet(sourceURL?: string) {
  if (!sourceURL) return false;
  return sourceURL.endsWith(stylesUrlSuffix);
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
      (usage) => usage.styleSheetId === styleSheetId
    );
    if (relevantUsage.length === 0) continue;
    const { text } = await session.send("CSS.getStyleSheetText", {
      styleSheetId,
    });
    for (const usage of relevantUsage) {
      const ruleKey = getRuleKey(usage.startOffset, usage.endOffset);
      if (!allRules.has(ruleKey)) {
        const ruleText = text.slice(usage.startOffset, usage.endOffset);
        allRules.set(ruleKey, {
          startOffset: usage.startOffset,
          endOffset: usage.endOffset,
          selector: extractSelector(ruleText),
        });
      }
      if (usage.used) {
        usedRules.add(ruleKey);
      }
    }
  }
  await session.detach();
}

/** Writes what this worker saw; called once when the worker shuts down. */
export function writeWorkerCssCoverage(workerIndex: number) {
  const dir = process.env[coverageDirEnv];
  if (!dir || allRules.size === 0) return;
  const coverage: WorkerCoverage = { rules: [...allRules], used: [...usedRules] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `worker-${workerIndex}-${process.pid}.json`), JSON.stringify(coverage));
}

export function setupCssCoverage() {
  process.env[coverageDirEnv] = mkdtempSync(join(tmpdir(), "a4-tasklists-css-coverage-"));
}

export function reportCssCoverage() {
  const dir = process.env[coverageDirEnv];
  if (!dir) return;
  const rules = new Map<RuleKey, RuleRecord>();
  const used = new Set<RuleKey>();
  for (const file of readdirSync(dir)) {
    const coverage = JSON.parse(readFileSync(join(dir, file), "utf8")) as WorkerCoverage;
    for (const [key, record] of coverage.rules) rules.set(key, record);
    for (const key of coverage.used) used.add(key);
  }
  rmSync(dir, { recursive: true, force: true });
  if (rules.size === 0) return;

  const unused = [...rules.entries()]
    .filter(([ruleKey]) => !used.has(ruleKey))
    .map(([, record]) => record);
  if (unused.length === 0) {
    console.warn("[css-coverage] All tracked rules were exercised.");
    return;
  }
  console.warn(
    `[css-coverage] ${unused.length} unused rule(s) detected in ${stylesUrlSuffix}:`
  );
  for (const record of unused.slice(0, 50)) {
    console.warn(`[css-coverage] - ${formatRuleSnippet(record)}`);
  }
  if (unused.length > 50) {
    console.warn(`[css-coverage] ...and ${unused.length - 50} more.`);
  }
}
