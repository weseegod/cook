/** localStorage keys under `cook.*`. */

const PREFIX = "cook.";

export function storageKey(suffix: string): string {
  return `${PREFIX}${suffix}`;
}

export function readLocal(suffix: string): string | null {
  return localStorage.getItem(storageKey(suffix));
}

export function writeLocal(suffix: string, value: string): void {
  localStorage.setItem(storageKey(suffix), value);
}
