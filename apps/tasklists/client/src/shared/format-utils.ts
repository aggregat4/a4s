/**
 * Formats match count for display in sidebar/move dialog.
 * Returns "No matches" for 0, "1 match" for 1, "N matches" for N.
 */
export function formatMatchCount(count: number): string {
  if (!count) return "No matches";
  return count === 1 ? "1 match" : `${count} matches`;
}

/**
 * Formats total count for display in sidebar/move dialog.
 * Returns "Empty" for 0, "1" for 1, "N" for N.
 */
export function formatTotalCount(count: number): string {
  if (!count) return "Empty";
  return count === 1 ? "1" : `${count}`;
}
