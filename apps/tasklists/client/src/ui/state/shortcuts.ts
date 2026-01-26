type ModifierKey = "mod" | "shift" | "alt" | "meta" | "ctrl";

type Shortcut = {
  id: string;
  key: string;
  modifiers?: ModifierKey[];
  allowExtraModifiers?: ModifierKey[];
};

const SHORTCUTS = {
  splitTask: {
    id: "split-task",
    key: "enter",
  },
  undo: {
    id: "undo",
    key: "z",
    modifiers: ["mod"],
  },
  redo: {
    id: "redo",
    key: "z",
    modifiers: ["mod", "shift"],
  },
  redoAlt: {
    id: "redo-alt",
    key: "y",
    modifiers: ["mod"],
  },
  moveTask: {
    id: "move-task",
    key: "m",
    modifiers: ["ctrl", "alt"],
  },
  deleteTask: {
    id: "delete-task",
    key: "backspace",
    modifiers: ["mod", "shift"],
  },
  toggleNote: {
    id: "toggle-note",
    key: "n",
    modifiers: ["alt"],
  },
  jumpToListStart: {
    id: "jump-list-start",
    key: "home",
    modifiers: ["ctrl"],
  },
  jumpToListEnd: {
    id: "jump-list-end",
    key: "end",
    modifiers: ["ctrl"],
  },
  toggleDone: {
    id: "toggle-done",
    key: "enter",
    modifiers: ["ctrl"],
  },
  moveItemUp: {
    id: "move-item-up",
    key: "arrowup",
    modifiers: ["mod"],
  },
  moveItemDown: {
    id: "move-item-down",
    key: "arrowdown",
    modifiers: ["mod"],
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

export { SHORTCUTS, matchesShortcut, pickShortcut };
