/**
 * What a matched pattern becomes in task text:
 * - "search": a toggle button that adds the matched text (a #tag or @context)
 *   to the search, or removes it when it is already searched for.
 * - "link": a link to the matched URL, opened in a new tab.
 * - undefined: a styled span only.
 * Notes are drawn behind their text box, so they always get styled spans.
 */
type PatternKind = "search" | "link";

interface PatternConfig {
  regexSource: string;
  regexFlags: string;
  className: string;
  key: string;
  priority: number;
  kind?: PatternKind;
}

interface TokenRange {
  start: number;
  end: number;
  pattern: PatternConfig;
}

interface MarkRange {
  start: number;
  end: number;
}

const escapeHTML = (str: string) =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * A URL in running text: "https://…" up to whitespace, minus trailing
 * punctuation that ends the sentence rather than the URL. A closing bracket is
 * kept when the URL opened it, as in Wikipedia links.
 */
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/g;

const trimUrlEnd = (url: string) => {
  let end = url.length;
  while (end > 0) {
    const char = url[end - 1];
    if (".,;:!?'\"".includes(char)) {
      end -= 1;
      continue;
    }
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const opener = pairs[char];
    if (opener) {
      const body = url.slice(0, end);
      const opened = body.split(opener).length - 1;
      const closed = body.split(char).length - 1;
      if (closed > opened) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
};

/** Pattern matches, without overlaps: the earliest, then the longest, wins. */
const findTokenRanges = (original: string, patterns: PatternConfig[]) => {
  const candidates: TokenRange[] = [];
  patterns.forEach((pattern) => {
    const regex = new RegExp(pattern.regexSource, pattern.regexFlags);
    let match;
    while ((match = regex.exec(original)) !== null) {
      if (!match[0].length) {
        regex.lastIndex += 1;
        continue;
      }
      const text =
        pattern.kind === "link" ? trimUrlEnd(match[0]) : match[0];
      if (text.length) {
        candidates.push({
          start: match.index,
          end: match.index + text.length,
          pattern,
        });
      }
      if (!regex.global) break;
    }
  });
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const ranges: TokenRange[] = [];
  candidates.forEach((candidate) => {
    const last = ranges[ranges.length - 1];
    if (last && candidate.start < last.end) return;
    ranges.push(candidate);
  });
  return ranges;
};

/** Where the search tokens occur, merged into non-overlapping ranges. */
const findMarkRanges = (haystack: string, tokens: string[]) => {
  const ranges: MarkRange[] = [];
  tokens.forEach((token) => {
    let index = haystack.indexOf(token);
    while (index !== -1) {
      ranges.push({ start: index, end: index + token.length });
      index = haystack.indexOf(token, index + token.length);
    }
  });
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MarkRange[] = [];
  ranges.forEach((range) => {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  });
  return merged;
};

/** Escaped text of [start, end) with the search marks inside it. */
const markSlice = (
  original: string,
  start: number,
  end: number,
  marks: MarkRange[]
) => {
  let result = "";
  let position = start;
  marks.forEach((mark) => {
    const from = Math.max(mark.start, start);
    const to = Math.min(mark.end, end);
    if (from >= to) return;
    result += escapeHTML(original.slice(position, from));
    result += `<mark>${escapeHTML(original.slice(from, to))}</mark>`;
    position = to;
  });
  return result + escapeHTML(original.slice(position, end));
};

const wrapToken = (
  range: TokenRange,
  text: string,
  inner: string,
  interactive: boolean,
  searchTokens: string[]
) => {
  const { className, kind } = range.pattern;
  if (interactive && kind === "link") {
    return `<a class="${className}" href="${escapeHTML(text)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
  }
  if (interactive && kind === "search") {
    const token = escapeHTML(text);
    const pressed = searchTokens.includes(text.toLowerCase());
    const title = pressed
      ? `Remove ${token} from the search`
      : `Search for ${token}`;
    return `<button type="button" class="${className}" data-search-token="${token}" aria-pressed="${pressed}" title="${title}">${inner}</button>`;
  }
  return `<span class="${className}">${inner}</span>`;
};

const buildDecoratedMarkup = (
  original: string,
  tokens: string[],
  patternConfig: PatternConfig[],
  { interactive = false }: { interactive?: boolean } = {}
) => {
  const patterns = Array.isArray(patternConfig) ? patternConfig : [];
  const marks = findMarkRanges(original.toLowerCase(), tokens);
  const tokenRanges = findTokenRanges(original, patterns);
  if (!marks.length && !tokenRanges.length) {
    return { markup: null };
  }
  let markup = "";
  let position = 0;
  tokenRanges.forEach((range) => {
    markup += markSlice(original, position, range.start, marks);
    const inner = markSlice(original, range.start, range.end, marks);
    const text = original.slice(range.start, range.end);
    markup += wrapToken(range, text, inner, interactive, tokens);
    position = range.end;
  });
  markup += markSlice(original, position, original.length, marks);
  return { markup };
};

export const tokenizeSearchQuery = (query: string) => {
  if (typeof query !== "string") return [];
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.toLowerCase());
};

export const evaluateSearchEntry = ({
  originalText,
  noteText,
  tokens,
  patternConfig,
  showDone,
  isDone,
}: {
  originalText: string;
  noteText: string;
  tokens: string[];
  patternConfig: PatternConfig[];
  showDone: boolean;
  isDone: boolean;
}) => {
  const hiddenByCompletion = !showDone && isDone;
  if (hiddenByCompletion) {
    return { hidden: true, markup: null, noteMarkup: null, noteMatched: false };
  }

  const safeText = typeof originalText === "string" ? originalText : "";
  const safeNote = typeof noteText === "string" ? noteText : "";
  const haystack = `${safeText}\n${safeNote}`.toLowerCase();
  const matchesAllTokens = tokens.every((token) => haystack.includes(token));
  const { markup } = buildDecoratedMarkup(safeText, tokens, patternConfig, {
    interactive: true,
  });
  if (tokens.length > 0 && !matchesAllTokens) {
    return { hidden: true, markup: null, noteMarkup: null, noteMatched: false };
  }

  // noteMatched is true only during an active search whose query appears in
  // the note; it drives auto-expand and guarantees noteMarkup has mark ranges.
  const noteMatched =
    tokens.length > 0 &&
    tokens.some((token) => safeNote.toLowerCase().includes(token));
  const { markup: noteMarkup } = noteMatched
    ? buildDecoratedMarkup(safeNote, tokens, patternConfig)
    : { markup: null };

  return { hidden: false, markup, noteMarkup, noteMatched };
};

export const matchesSearchEntry = ({
  originalText,
  noteText,
  tokens,
  showDone,
  isDone,
}: {
  originalText: string;
  noteText: string;
  tokens: string[];
  showDone: boolean;
  isDone: boolean;
}) => {
  if (!showDone && isDone) {
    return false;
  }
  if (!tokens || tokens.length === 0) {
    return true;
  }
  const safeText = typeof originalText === "string" ? originalText : "";
  const safeNote = typeof noteText === "string" ? noteText : "";
  const haystack = `${safeText}\n${safeNote}`.toLowerCase();
  return tokens.every((token) => haystack.includes(token));
};

export { URL_PATTERN, buildDecoratedMarkup };
export type { PatternConfig, PatternKind };
