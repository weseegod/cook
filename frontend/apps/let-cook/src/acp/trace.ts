import { normalizeError } from "./errors";

const enabled = import.meta.env.DEV || import.meta.env.VITE_DESKTOP_TRACE === "1";

export function desktopTrace(event: string, detail?: unknown): void {
  if (!enabled) return;
  console.debug(`[desktop:${event}]`, detail ?? "");
}

export function desktopError(event: string, detail?: unknown): void {
  console.error(`[desktop:${event}]`, normalizeError(detail));
}
