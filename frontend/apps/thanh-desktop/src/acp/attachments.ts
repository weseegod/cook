/**
 * Attachments → ACP prompt parts.
 *
 * Images become `image` parts (base64 + media type); everything else becomes a `resource_link`
 * plus a text hint naming the path, so PDF/PPTX reach the agent's `read_file` instead of being
 * inlined by the renderer. Images are unavailable on models whose `inputModalities` exclude them.
 */
import type { ContentBlock } from "@agentclientprotocol/sdk";

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  kind: "image" | "file";
  /** base64 payload (images only). */
  data?: string;
  /** `data:` URL for on-screen preview (images only). */
  previewUrl?: string;
  /** Absolute path when the source was a real file on disk. */
  path?: string;
}

export type PromptPart = ContentBlock;

export interface RejectedAttachment {
  name: string;
  reason: string;
}

export interface PromptParts {
  parts: PromptPart[];
  rejected: RejectedAttachment[];
}

/** 5 MiB: larger images are refused rather than ballooning the prompt. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function imageAttachEnabled(model?: { inputModalities?: string[] } | null): boolean {
  if (!model) return true;
  if (!model.inputModalities) return true;
  return model.inputModalities.includes("image");
}

export function isImage(file: { type?: string; name?: string }): boolean {
  if (file.type?.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name ?? "");
}

export function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

/** Turn a dropped/pasted file into an attachment (data URL in, attachment out). */
export function attachmentFromFile(file: File, dataUrl: string, path?: string): Attachment {
  const image = isImage(file);
  const mediaType = file.type || (image ? "image/png" : "application/octet-stream");
  return {
    id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || "pasted-image.png",
    mediaType,
    size: file.size,
    kind: image ? "image" : "file",
    data: image ? base64FromDataUrl(dataUrl) : undefined,
    previewUrl: image ? dataUrl : undefined,
    path,
  };
}

/**
 * Build the `session/prompt` content blocks for one turn.
 *
 * A text-only model rejects images here (visible in the UI) rather than sending a request the
 * provider would 400 on.
 */
export function buildPromptParts(
  text: string,
  attachments: Attachment[],
  options: { supportsImages: boolean },
): PromptParts {
  const parts: PromptPart[] = [];
  const rejected: RejectedAttachment[] = [];
  const trimmed = text.trim();
  if (trimmed) parts.push({ type: "text", text: trimmed });

  for (const attachment of attachments) {
    if (attachment.size > MAX_FILE_BYTES) {
      rejected.push({ name: attachment.name, reason: "file is larger than 25 MB" });
      continue;
    }
    if (attachment.kind === "image") {
      if (!options.supportsImages) {
        rejected.push({ name: attachment.name, reason: "the selected model cannot read images" });
        continue;
      }
      if (attachment.size > MAX_IMAGE_BYTES) {
        rejected.push({ name: attachment.name, reason: "image is larger than 5 MB" });
        continue;
      }
      if (!attachment.data) {
        rejected.push({ name: attachment.name, reason: "image data was lost before sending" });
        continue;
      }
      parts.push({ type: "image", mimeType: attachment.mediaType, data: attachment.data });
      continue;
    }
    parts.push({ type: "text", text: fileHint(attachment) });
    if (attachment.path) {
      parts.push({
        type: "resource_link",
        name: attachment.name,
        uri: `file://${attachment.path}`,
        mimeType: attachment.mediaType,
        size: attachment.size,
      });
    }
  }
  return { parts, rejected };
}

function fileHint(attachment: Attachment): string {
  const kb = Math.max(1, Math.round(attachment.size / 1024));
  if (!attachment.path) {
    return `Attached file: ${attachment.name} (${attachment.mediaType}, ${kb} KB). Its contents were not sent; ask the user for the path if you need them.`;
  }
  return `Attached file: ${attachment.path} (${attachment.mediaType}, ${kb} KB). Use the read_file tool to read it.`;
}

/** Everything the transcript should show for the user's own turn. */
export function optimisticImages(attachments: Attachment[]): string[] {
  return attachments.map((attachment) => attachment.previewUrl).filter((url): url is string => Boolean(url));
}

/** Media type from the extension, matching the Tauri-side reader. */
export function mediaTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    toml: "text/plain",
  };
  return known[extension] ?? "application/octet-stream";
}

export function basename(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/**
 * Build an attachment from a real path (native picker or OS drop).
 *
 * With a payload an image travels inline; without one it stays a path attachment, because the
 * renderer has no bytes to send and inventing an empty `image` part would fail at the provider.
 */
export function attachmentFromPath(
  path: string,
  payload?: { data: string; mediaType: string; size: number } | null,
): Attachment {
  const name = basename(path);
  const mediaType = payload?.mediaType ?? mediaTypeForPath(path);
  const image = isImage({ name });
  const inline = image && Boolean(payload?.data);
  return {
    id: `${name}-${payload?.size ?? 0}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    mediaType,
    size: payload?.size ?? 0,
    kind: inline ? "image" : "file",
    data: inline ? payload!.data : undefined,
    previewUrl: inline ? `data:${mediaType};base64,${payload!.data}` : undefined,
    path,
  };
}
