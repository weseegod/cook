/** In-flight OAuth Connect; kept off MockState because persist() JSON-clones it. */

export let grokAuthResolve: (() => void) | null = null;
export const approvedOauth = new Set<string>();
export let pendingOauth: {
  id: string;
  mode: "device" | "paste";
  authorizeUrl: string;
  userCode: string | null;
} | null = null;

export function resetMockOauth(): void {
  pendingOauth = null;
  grokAuthResolve = null;
  approvedOauth.clear();
}

export function setPendingOauth(next: typeof pendingOauth): void {
  pendingOauth = next;
}

export function setGrokAuthResolve(next: (() => void) | null): void {
  grokAuthResolve = next;
}
