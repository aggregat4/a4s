import test from "node:test";
import assert from "node:assert/strict";
import {
  URL_PATTERN,
  buildDecoratedMarkup,
} from "../../../src/ui/state/highlight-utils.js";
import type { PatternConfig } from "../../../src/ui/state/highlight-utils.js";

const patterns: PatternConfig[] = [
  {
    regexSource: URL_PATTERN.source,
    regexFlags: URL_PATTERN.flags,
    className: "task-token-link",
    key: "pattern:link",
    priority: 2,
    kind: "link",
  },
  {
    regexSource: /(?<![\w@#])@[A-Za-z0-9_]+/.source,
    regexFlags: "g",
    className: "task-token-mention",
    key: "pattern:mention",
    priority: 2,
    kind: "search",
  },
  {
    regexSource: /(?<![\w@#])#[A-Za-z0-9_]+/.source,
    regexFlags: "g",
    className: "task-token-tag",
    key: "pattern:tag",
    priority: 2,
    kind: "search",
  },
];

const decorate = (text: string, tokens: string[] = [], interactive = true) =>
  buildDecoratedMarkup(text, tokens, patterns, { interactive }).markup;

const link = (url: string, inner = url) =>
  `<a class="task-token-link" href="${url}" target="_blank" rel="noopener noreferrer">${inner}</a>`;

const searchButton = (
  className: string,
  token: string,
  inner = token,
  pressed = false
) =>
  `<button type="button" class="${className}" data-search-token="${token}" aria-pressed="${pressed}" title="${
    pressed ? `Remove ${token} from the search` : `Search for ${token}`
  }">${inner}</button>`;

test("plain text without tokens or search needs no markup", () => {
  assert.equal(decorate("Buy milk"), null);
});

test("URLs become links that leave trailing punctuation outside", () => {
  assert.equal(
    decorate("See https://example.com/docs."),
    `See ${link("https://example.com/docs")}.`
  );
  assert.equal(
    decorate("(see https://example.com/a)"),
    `(see ${link("https://example.com/a")})`
  );
});

test("URLs keep brackets they open themselves", () => {
  const url = "https://en.wikipedia.org/wiki/Tea_(drink)";
  assert.equal(decorate(`Read ${url}`), `Read ${link(url)}`);
});

test("tags and contexts become search buttons", () => {
  assert.equal(
    decorate("Fix bike #garage @home"),
    `Fix bike ${searchButton("task-token-tag", "#garage")} ${searchButton(
      "task-token-mention",
      "@home"
    )}`
  );
});

test("e-mail addresses and URL fragments hold no contexts or tags", () => {
  assert.equal(decorate("Mail me@example.com"), null);
  const url = "https://example.com/page#section";
  assert.equal(decorate(url), link(url));
});

test("search marks stay inside a token instead of splitting it", () => {
  assert.equal(
    decorate("Fix #garage door", ["gar"]),
    `Fix ${searchButton(
      "task-token-tag",
      "#garage",
      "#<mark>gar</mark>age"
    )} door`
  );
});

test("tags already searched for are pressed", () => {
  assert.equal(
    decorate("Fix #Garage", ["#garage"]),
    `Fix ${searchButton(
      "task-token-tag",
      "#Garage",
      "<mark>#Garage</mark>",
      true
    )}`
  );
});

test("marks spanning a token boundary are split at the boundary", () => {
  assert.equal(
    decorate("x#tag", ["x#t"]),
    "<mark>x#t</mark>ag"
  );
  assert.equal(
    decorate("go #tag", ["o #t"]),
    `g<mark>o </mark>${searchButton("task-token-tag", "#tag", "<mark>#t</mark>ag")}`
  );
});

test("non-interactive markup uses spans, as for notes", () => {
  assert.equal(
    decorate("#garage https://example.com", [], false),
    '<span class="task-token-tag">#garage</span> <span class="task-token-link">https://example.com</span>'
  );
});

test("text is escaped inside and around tokens", () => {
  assert.equal(
    decorate("<b> https://example.com/?a=1&b=2"),
    `&lt;b&gt; ${link(
      "https://example.com/?a=1&amp;b=2",
      "https://example.com/?a=1&amp;b=2"
    )}`
  );
});
