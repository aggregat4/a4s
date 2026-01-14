export type CaretBias = "start" | "end";

export type CaretPreference =
  | "start"
  | "end"
  | { type: "offset"; value: number; bias?: CaretBias }
  | {
      type: "caret-column";
      x?: number | null;
      bias?: CaretBias;
      fallbackOffset?: number | null;
    };

export const isOffsetCaret = (
  preference: CaretPreference | null
): preference is { type: "offset"; value: number; bias?: CaretBias } =>
  Boolean(
    preference &&
      typeof preference === "object" &&
      "type" in preference &&
      preference.type === "offset"
  );
