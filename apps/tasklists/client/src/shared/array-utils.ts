/**
 * Compares two arrays for equality using strict equality (===) on each element.
 * Returns true if arrays are the same reference, have same length, and all elements equal.
 */
export function arraysEqual<T>(a: T[] = [], b: T[] = []): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
