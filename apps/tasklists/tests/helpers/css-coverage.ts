import type { CDPSession, Page } from "@playwright/test";

type RuleKey = string;

type RuleRecord = {
  styleSheetId: string;
  startOffset: number;
  endOffset: number;
  selector: string;
};

type CoverageState = {
  allRuleKeys: Map<RuleKey, RuleRecord>;
  usedRuleKeys: Set<RuleKey>;
  sheetTextById: Map<string, string>;
};

const coverageState: CoverageState = {
  allRuleKeys: new Map(),
  usedRuleKeys: new Set(),
  sheetTextById: new Map(),
};

const stylesUrlSuffix = "/styles.css";

function getRuleKey(
  styleSheetId: string,
  startOffset: number,
  endOffset: number
) {
  return `${styleSheetId}:${startOffset}:${endOffset}`;
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
  return process.env.PLAYWRIGHT_CSS_COVERAGE === "1";
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
    if (!coverageState.sheetTextById.has(styleSheetId)) {
      const { text } = await session.send("CSS.getStyleSheetText", {
        styleSheetId,
      });
      coverageState.sheetTextById.set(styleSheetId, text);
    }
    const sheetText = coverageState.sheetTextById.get(styleSheetId) ?? "";
    for (const usage of relevantUsage) {
      const ruleKey = getRuleKey(
        usage.styleSheetId,
        usage.startOffset,
        usage.endOffset
      );
      if (!coverageState.allRuleKeys.has(ruleKey)) {
        const ruleText = sheetText.slice(usage.startOffset, usage.endOffset);
        const selector = extractSelector(ruleText);
        coverageState.allRuleKeys.set(ruleKey, {
          styleSheetId: usage.styleSheetId,
          startOffset: usage.startOffset,
          endOffset: usage.endOffset,
          selector,
        });
      }
      if (usage.used) {
        coverageState.usedRuleKeys.add(ruleKey);
      }
    }
  }
  await session.detach();
}

export function reportCssCoverageWarnings() {
  if (coverageState.allRuleKeys.size === 0) return;
  const unused = [...coverageState.allRuleKeys.entries()]
    .filter(([ruleKey]) => !coverageState.usedRuleKeys.has(ruleKey))
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
    console.warn(
      `[css-coverage] ...and ${unused.length - 50} more.`
    );
  }
}
