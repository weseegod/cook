/** Convert every transport/runtime error into one safe, user-facing message. */
const SECRET_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|bearer(?:\s+token)?)\s*[:=]\s*["']?[^\s,"'}]+/gi;
const STACK_PATTERN = /\s+at\s+[^\n]+/g;
const MAX_ERROR_LENGTH = 600;

export function normalizeError(error: unknown, fallback = "Something went wrong"): string {
  const raw = extractMessage(error).trim();
  if (!raw || raw === "{}" || raw === "[object Object]") return fallback;

  const safe = raw
    .replace(SECRET_PATTERN, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(STACK_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^Error:\s*/i, "");
  return safe ? safe.slice(0, MAX_ERROR_LENGTH) : fallback;
}

export function errorNotice(context: string, error: unknown, fallback = "Something went wrong"): string {
  return `${context}: ${normalizeError(error, fallback)}`;
}

function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "detail"]) {
      if (record[key] !== undefined && record[key] !== error) {
        const nested = extractMessage(record[key]);
        if (nested) return nested;
      }
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "";
    }
  }
  return error == null ? "" : String(error);
}
