## Goal
Replace the current `contenteditable` inline editor with a controlled `<textarea>`-based editor that keeps the seamless look while reducing DOM/event complexity.

## Approach
1. **Single Reusable Textarea**
   - Lazily create one `<textarea>` instance the first time editing starts.
   - On each edit session, detach it from any previous host, append it to the active list item, and populate it with the item text.

2. **Hide Original Text Node, Mirror Styles**
   - Temporarily hide the original `.text` span (`visibility:hidden` or similar) so layout stays intact.
   - Copy relevant computed styles (font, line-height, padding, color, etc.) onto the textarea so the swap is visually identical.
   - Attach a `resize` routine to auto-size the textarea (`scrollHeight`) as the user types.

3. **Event Wiring**
   - Replace `contenteditable` listeners with textarea events (`input`, `keydown`, `blur`).
   - Reimplement keyboard behaviors (Enter to split, Escape to cancel, Backspace merge/remove shortcuts) using textarea selection APIs (`selectionStart`, `selectionEnd`).
   - Reuse existing callbacks (`onCommit`, `onSplit`, `onMerge`, `onRemove`) so higher-level logic stays the same.

4. **Caret Handling**
   - When editing starts, map pointer location or saved caret preference to textarea selection ranges.
   - Preserve caret placement across merges/splits by translating between stored offsets and textarea indices.

5. **Cleanup & Focus Management**
   - On finish/cancel, remove listeners, detach the textarea from the DOM, restore the `.text` span visibility/state, and re-enable drag handles.
   - Ensure `finishEditing` always runs, even when merges/removes hand editing to another item.

6. **Styling Updates**
   - Add a minimal CSS class (e.g., `.inline-editor__textarea`) for the shared textarea (reset borders, outlines, set `background:transparent`, etc.).
   - Keep `.tasklist li.editing` styles for the editing state; optionally mirror them onto the textarea for consistent focus outlines.

7. **Tests**
   - Update Playwright specs to assert textarea visibility/focus instead of `contenteditable`.
   - Re-run the end-to-end suite to cover add/split/merge/remove flows and ensure keyboard scenarios still pass.

## Notes
- By reusing a single textarea we avoid a proliferation of hidden nodes.
- Keeping the original `.text` element in the DOM (just hidden) ensures layout stability and lets us fall back if editing is cancelled.
- Auto-resizing and style mirroring preserve the “inline” appearance without relying on `contenteditable`.
