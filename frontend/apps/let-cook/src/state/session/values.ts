import type { ToolBlock } from "./types";

export function isTurnActivity(kind: string): boolean {
  return [
    "user_message_chunk",
    "agent_message_chunk",
    "agent_thought_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "plan_update",
  ].includes(kind);
}

export function isTerminalToolStatus(status: string): boolean {
  return ["completed", "complete", "failed", "error", "cancelled", "canceled"].includes(status.toLowerCase());
}

export function toolMetadata(raw: Record<string, unknown>, previous: ToolBlock | null) {
  const input = asRecord(raw.rawInput) ?? asRecord(raw.input) ?? asRecord(raw.arguments) ?? {};
  const command = firstString(
    raw.command,
    input.command,
    previous?.command,
  );
  const description = firstString(raw.description, input.description, previous?.description);
  const paths = uniqueStrings([
    ...stringArray(raw.paths),
    ...stringArray(raw.locations),
    ...stringArray(input.paths),
    ...stringArray(input.path),
    ...stringArray(input.filePath),
    ...(previous?.paths ?? []),
  ]);
  return { command, description, paths };
}

export function toolContent(raw: Record<string, unknown>, previous: ToolBlock | null): unknown[] {
  if (Array.isArray(raw.content)) return raw.content;
  const delta = firstString(raw.outputDelta, raw.contentDelta, raw.delta);
  if (!delta) return previous?.content ?? [];
  const content = [...(previous?.content ?? [])];
  const last = asRecord(content.at(-1));
  const lastValue = last ? asRecord(last.content) : null;
  if (last?.type === "content" && lastValue?.type === "text" && typeof lastValue.text === "string") {
    content[content.length - 1] = { ...last, content: { ...lastValue, text: `${lastValue.text}${delta}` } };
    return content;
  }
  return [...content, { type: "content", content: { type: "text", text: delta } }];
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

export function stringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return [item];
    const record = asRecord(item);
    return record ? [firstString(record.path, record.filePath, record.uri)].filter((item): item is string => Boolean(item)) : [];
  });
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function contentImage(content: Record<string, unknown> | null): string | null {
  return content?.type === "image" && typeof content.data === "string"
    ? `data:${String(content.mimeType ?? "image/png")};base64,${content.data}`
    : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function stringOr(value: unknown, fallback?: string): string | undefined {
  return typeof value === "string" ? value : fallback;
}

export function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
