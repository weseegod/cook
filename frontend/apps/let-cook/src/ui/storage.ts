/** localStorage keys under `cook.*`, with one-release read fallback to `thanh.*`. */

const PREFIX = "cook.";
const LEGACY_PREFIX = "thanh.";

export function storageKey(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

export function readLocal(suffix: string): string | null {
  const next = localStorage.getItem(storageKey(suffix));
  if (next !== null) return next;
  return localStorage.getItem(`${LEGACY_PREFIX}${suffix}`);
}

export function writeLocal(suffix: string, value: string): void {
  localStorage.setItem(storageKey(suffix), value);
}
