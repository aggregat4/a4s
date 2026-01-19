type ModifierKey = "mod" | "shift" | "alt" | "meta" | "ctrl";

type Shortcut = {
  id: string;
  key: string;
  modifiers?: ModifierKey[];
  allowExtraModifiers?: ModifierKey[];
};

const SHORTCUTS = {
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

export { SHORTCUTS, matchesShortcut };
