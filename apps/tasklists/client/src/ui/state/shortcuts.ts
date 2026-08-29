type ModifierKey = "mod" | "shift" | "alt" | "meta" | "ctrl";

type Shortcut = {
  id: string;
  key: string;
  modifiers?: ModifierKey[];
  allowExtraModifiers?: ModifierKey[];
  description: string;
  category?: string;
  /** Overrides the formatted key label (modifiers are still rendered). */
  displayLabel?: string;
};

const SHORTCUTS = {
  splitTask: {
    id: "split-task",
    key: "enter",
    description: "Split the current task into two at the cursor",
    category: "Editing",
  },
  undo: {
    id: "undo",
    key: "z",
    modifiers: ["mod"],
    description: "Undo the last action",
    category: "History",
  },
  redo: {
    id: "redo",
    key: "z",
    modifiers: ["mod", "shift"],
    description: "Redo the last undone action",
    category: "History",
  },
  redoAlt: {
    id: "redo-alt",
    key: "y",
    modifiers: ["mod"],
    description: "Redo (alternate key)",
    category: "History",
  },
  moveTask: {
    id: "move-task",
    key: "m",
    modifiers: ["ctrl", "alt"],
    description: "Move the current task to another list",
    category: "Tasks",
  },
  deleteTask: {
    id: "delete-task",
    key: "backspace",
    modifiers: ["mod", "shift"],
    description: "Delete the current task",
    category: "Tasks",
  },
  toggleNote: {
    id: "toggle-note",
    key: "n",
    modifiers: ["alt"],
    description: "Show or hide the note for the current task",
    category: "Tasks",
  },
  jumpToListStart: {
    id: "jump-list-start",
    key: "home",
    modifiers: ["ctrl"],
    description: "Jump to the first task in the list",
    category: "Navigation",
  },
  jumpToListEnd: {
    id: "jump-list-end",
    key: "end",
    modifiers: ["ctrl"],
    description: "Jump to the last task in the list",
    category: "Navigation",
  },
  toggleDone: {
    id: "toggle-done",
    key: "enter",
    modifiers: ["ctrl"],
    description: "Toggle the current task complete",
    category: "Tasks",
  },
  moveItemUp: {
    id: "move-item-up",
    key: "arrowup",
    modifiers: ["mod"],
    description: "Move the current task up (keeps the cursor)",
    category: "Editing",
  },
  moveItemDown: {
    id: "move-item-down",
    key: "arrowdown",
    modifiers: ["mod"],
    description: "Move the current task down (keeps the cursor)",
    category: "Editing",
  },
  help: {
    id: "shortcuts-help",
    key: "?",
    modifiers: ["alt"],
    // "?" requires Shift on most layouts, so allow it as an extra modifier.
    allowExtraModifiers: ["shift"],
    description: "Show or hide this keyboard shortcuts cheat sheet",
    category: "Help",
  },
  save: {
    id: "save-now",
    key: "s",
    modifiers: ["mod"],
    description: "Sync your changes to the server now",
    category: "Sync",
  },
} satisfies Record<string, Shortcut>;

const normalizeKey = (key: string | undefined | null) =>
  (key ?? "").toLowerCase();

const matchesShortcut = (event: KeyboardEvent, shortcut: Shortcut) => {
  if (!event || !shortcut) return false;
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) return false;
  const modifiers = new Set(shortcut.modifiers ?? []);
  const requiresMod = modifiers.has("mod");
  const allowedExtras = new Set(shortcut.allowExtraModifiers ?? []);
  if (requiresMod) {
    allowedExtras.add("meta");
    allowedExtras.add("ctrl");
  }
  const hasCtrl =
    event.ctrlKey || Boolean(event.getModifierState?.("Control"));
  const hasMeta = event.metaKey || Boolean(event.getModifierState?.("Meta"));
  const hasAlt = event.altKey || Boolean(event.getModifierState?.("Alt"));
  const hasShift = event.shiftKey || Boolean(event.getModifierState?.("Shift"));
  if (requiresMod && !(hasMeta || hasCtrl)) return false;
  if (modifiers.has("meta") && !hasMeta) return false;
  if (modifiers.has("ctrl") && !hasCtrl) return false;
  if (modifiers.has("alt") && !hasAlt) return false;
  if (modifiers.has("shift") && !hasShift) return false;
  if (!modifiers.has("meta") && hasMeta && !allowedExtras.has("meta")) {
    return false;
  }
  if (!modifiers.has("ctrl") && hasCtrl && !allowedExtras.has("ctrl")) {
    return false;
  }
  if (!modifiers.has("alt") && hasAlt && !allowedExtras.has("alt")) {
    return false;
  }
  if (!modifiers.has("shift") && hasShift && !allowedExtras.has("shift")) {
    return false;
  }
  return true;
};

const getShortcutSpecificity = (shortcut: Shortcut) => {
  const modifiers = new Set(shortcut.modifiers ?? []);
  return modifiers.size;
};

const pickShortcut = (
  event: KeyboardEvent,
  shortcuts: Shortcut[]
) => {
  if (!event || !Array.isArray(shortcuts)) return null;
  const matches = shortcuts.filter((shortcut) => matchesShortcut(event, shortcut));
  if (matches.length === 0) return null;
  matches.sort((a, b) => getShortcutSpecificity(b) - getShortcutSpecificity(a));
  return matches[0];
};

const isApplePlatform = () => {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator.platform ?? "").toLowerCase();
  const userAgent = (navigator.userAgent ?? "").toLowerCase();
  const applePattern = /mac|iphone|ipad|ipod/;
  return applePattern.test(platform) || applePattern.test(userAgent);
};

const MODIFIER_LABELS_APPLE: Record<ModifierKey, string> = {
  mod: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
};

const MODIFIER_LABELS_OTHER: Record<ModifierKey, string> = {
  mod: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
};

const KEY_LABELS: Record<string, string> = {
  enter: "↵",
  backspace: "⌫",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  home: "Home",
  end: "End",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  "?": "?",
};

const formatKeyLabel = (key: string) => {
  const normalized = normalizeKey(key);
  if (KEY_LABELS[normalized] !== undefined) return KEY_LABELS[normalized];
  if (normalized.length === 1) return normalized.toUpperCase();
  return normalized;
};

/**
 * Returns the ordered display tokens for a shortcut (one <kbd> per token),
 * platform-aware ("mod" renders as ⌘ on Apple, Ctrl elsewhere).
 */
const formatShortcutParts = (shortcut: Shortcut): string[] => {
  const labels = isApplePlatform()
    ? MODIFIER_LABELS_APPLE
    : MODIFIER_LABELS_OTHER;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const modifier of shortcut.modifiers ?? []) {
    const label = labels[modifier];
    if (label && !seen.has(label)) {
      parts.push(label);
      seen.add(label);
    }
  }
  parts.push(shortcut.displayLabel ?? formatKeyLabel(shortcut.key));
  return parts;
};

export { SHORTCUTS, matchesShortcut, pickShortcut, formatShortcutParts };
