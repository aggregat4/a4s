// Task text and list titles are single-line plain text edited in place with
// contenteditable. Browsers insert pasted or dropped rich content as markup,
// which carries formatting, merges block elements without a separator, and
// breaks the caret offsets the editors compute from text nodes. These helpers
// keep such an element as plain text on one line.

const LINE_BREAK = "[\\r\\n\\u2028\\u2029\\t\\v\\f]";
const LINE_BREAK_RUNS = new RegExp(`\\s*${LINE_BREAK}\\s*`, "g");
const EDGE_LINE_BREAKS = new RegExp(
  `^\\s*${LINE_BREAK}\\s*|\\s*${LINE_BREAK}\\s*$`,
  "g"
);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f]/g;
// Private-use character marking the caret while an element is flattened.
const CARET_MARKER = "";

const toSingleLine = (text: string) =>
  text.replace(LINE_BREAK_RUNS, " ").replace(CONTROL_CHARACTERS, "");

// Text to insert for a paste. Line breaks at either end (as in a copied
// paragraph) are dropped; those inside become spaces.
const toPastedText = (text: string) =>
  toSingleLine(text.replace(EDGE_LINE_BREAKS, ""));

/**
 * Pastes the clipboard's plain text instead of its rich content. Uses the
 * browser's insertText command where available so the paste is one native undo
 * step and fires a regular `input` event, like typing.
 */
const handlePlainTextPaste = (event: ClipboardEvent) => {
  const element = event.currentTarget as HTMLElement | null;
  if (!element?.isContentEditable || !event.clipboardData) return;
  event.preventDefault();
  const text = toPastedText(event.clipboardData.getData("text/plain"));
  if (!text.length) return;
  if (document.execCommand?.("insertText", false, text)) return;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  element.normalize();
  element.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      inputType: "insertFromPaste",
      data: text,
    })
  );
};

/**
 * Replaces any markup inside the element with its text on a single line,
 * keeping the caret at the same place in the text. Returns whether the element
 * changed. Call it from `input` handlers to cover markup that arrives without a
 * paste event, such as dropped content.
 */
const flattenToPlainText = (element: HTMLElement) => {
  if (element.childElementCount === 0) return false;
  const selection = window.getSelection();
  const range =
    selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const hasCaret = Boolean(range && element.contains(range.startContainer));
  if (range && hasCaret) {
    range.collapse(false);
    range.insertNode(document.createTextNode(CARET_MARKER));
  }
  // innerText (unlike textContent) turns block boundaries and <br> into line
  // breaks, which toSingleLine then turns into spaces.
  const marked = toSingleLine(element.innerText);
  const caretOffset = marked.indexOf(CARET_MARKER);
  const text = marked.replace(CARET_MARKER, "");
  element.textContent = text;
  if (selection && hasCaret && caretOffset !== -1 && element.firstChild) {
    selection.collapse(element.firstChild, caretOffset);
  } else if (selection && hasCaret) {
    selection.collapse(element, element.childNodes.length);
  }
  return true;
};

export { flattenToPlainText, handlePlainTextPaste };
