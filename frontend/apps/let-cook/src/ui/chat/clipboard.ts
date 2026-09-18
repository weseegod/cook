export async function copyText(text: string): Promise<void> {
  if (!text) throw new Error("Nothing to copy");
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard is unavailable");
}

export function displayPath(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value.slice("file://".length);
    }
  }
  return value;
}

export function copyableToolOutput(tool: { content: unknown[] }): string {
  return tool.content.map(contentText).filter(Boolean).join("\n");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value == null ? "" : String(value);
  const record = value as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (typeof record.text === "string") return record.text;
  if (record.content) return contentText(record.content);
  if (typeof record.output === "string") return record.output;
  if (typeof record.diff === "string") return record.diff;
  return JSON.stringify(value, null, 2);
}
