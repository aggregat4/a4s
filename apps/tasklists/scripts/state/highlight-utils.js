const escapeHTML = (str) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const mergeRanges = (ranges) => {
  if (!ranges.length) return [];
  const sorted = ranges.slice().sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.end !== b.end) return a.end - b.end;
    return a.key.localeCompare(b.key);
  });
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end && current.key === last.key) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }
  return merged;
};

const buildDecoratedMarkup = (original, tokens, patternConfig) => {
  const haystack = original.toLowerCase();
  const ranges = [];
  const patterns = Array.isArray(patternConfig) ? patternConfig : [];
  let matchesAllTokens = true;

  tokens.forEach((token) => {
    let searchIndex = 0;
    let foundAny = false;
    while (searchIndex <= haystack.length) {
      const found = haystack.indexOf(token, searchIndex);
      if (found === -1) break;
      ranges.push({
        start: found,
        end: found + token.length,
        priority: 1,
        open: "<mark>",
        close: "</mark>",
        key: "mark",
      });
      searchIndex = found + token.length;
      foundAny = true;
    }
    if (!foundAny) {
      matchesAllTokens = false;
    }
  });

  patterns.forEach((def) => {
    const patternRegex = new RegExp(def.regexSource, def.regexFlags);
    let match;
    while ((match = patternRegex.exec(original)) !== null) {
      if (!match[0].length) {
        patternRegex.lastIndex += 1;
        continue;
      }
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
        priority: def.priority,
        open: `<span class="${def.className}">`,
        close: "</span>",
        key: def.key,
      });
      if (!patternRegex.global) break;
    }
  });

  if (!ranges.length) {
    return { markup: null, matchesAllTokens };
  }

  const merged = mergeRanges(ranges);
  if (!merged.length) {
    return { markup: null, matchesAllTokens };
  }

  const boundaries = new Set([0, original.length]);
  merged.forEach((range) => {
    boundaries.add(range.start);
    boundaries.add(range.end);
  });
  const sortedBoundaries = Array.from(boundaries).sort((a, b) => a - b);

  let result = "";
  for (let i = 0; i < sortedBoundaries.length - 1; i++) {
    const start = sortedBoundaries[i];
    const end = sortedBoundaries[i + 1];
    if (start === end) continue;
    let segment = escapeHTML(original.slice(start, end));
    if (!segment) continue;
    const covering = merged.filter(
      (range) => range.start <= start && range.end >= end
    );
    if (covering.length) {
      covering.sort((a, b) => a.priority - b.priority);
      for (let j = covering.length - 1; j >= 0; j--) {
        const wrapper = covering[j];
        segment = wrapper.open + segment + wrapper.close;
      }
    }
    result += segment;
  }

  return { markup: result, matchesAllTokens };
};

export const tokenizeSearchQuery = (query) => {
  if (typeof query !== "string") return [];
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
};

export const evaluateSearchEntry = ({
  originalText,
  tokens,
  patternConfig,
  showDone,
  isDone,
}) => {
  const hiddenByCompletion = !showDone && isDone;
  if (hiddenByCompletion) {
    return { hidden: true, markup: null };
  }

  const { markup, matchesAllTokens } = buildDecoratedMarkup(
    originalText,
    tokens,
    patternConfig
  );
  if (tokens.length > 0 && !matchesAllTokens) {
    return { hidden: true, markup: null };
  }

  return { hidden: false, markup };
};
