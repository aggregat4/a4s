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
    allowExtraModifiers: ["shift"],
  },
} satisfies Record<string, Shortcut>;

const isMacPlatform = () => {
  if (typeof navigator === "undefined") return false;
  return navigator.platform?.toLowerCase?.().includes("mac") ?? false;
};

const normalizeKey = (key: string | undefined | null) =>
  (key ?? "").toLowerCase();

const matchesShortcut = (event: KeyboardEvent, shortcut: Shortcut) => {
  if (!event || !shortcut) return false;
  if (normalizeKey(event.key) !== normalizeKey(shortcut.key)) return false;
  const modifiers = shortcut.modifiers ?? [];
  const allowedExtras = new Set(shortcut.allowExtraModifiers ?? []);
  const requires = {
    meta: modifiers.includes("meta"),
    ctrl: modifiers.includes("ctrl"),
    alt: modifiers.includes("alt"),
    shift: modifiers.includes("shift"),
  };
  if (modifiers.includes("mod")) {
    if (isMacPlatform()) {
      requires.meta = true;
    } else {
      requires.ctrl = true;
    }
  }
  if (requires.meta && !event.metaKey) return false;
  if (requires.ctrl && !event.ctrlKey) return false;
  if (requires.alt && !event.altKey) return false;
  if (requires.shift && !event.shiftKey) return false;
  if (!requires.meta && event.metaKey && !allowedExtras.has("meta")) return false;
  if (!requires.ctrl && event.ctrlKey && !allowedExtras.has("ctrl")) return false;
  if (!requires.alt && event.altKey && !allowedExtras.has("alt")) return false;
  if (!requires.shift && event.shiftKey && !allowedExtras.has("shift")) return false;
  return true;
};

export { SHORTCUTS, matchesShortcut };
