import { describe, expect, it } from "vitest";
import {
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  attachmentFromFile,
  attachmentFromPath,
  buildPromptParts,
  imageAttachEnabled,
  isImage,
  mediaTypeForPath,
  optimisticImages,
  type Attachment,
} from "./attachments";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function imageAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "a1",
    name: "shot.png",
    mediaType: "image/png",
    size: 1024,
    kind: "image",
    data: PNG_BASE64,
    previewUrl: `data:image/png;base64,${PNG_BASE64}`,
    ...overrides,
  };
}

function fileAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "f1",
    name: "report.pdf",
    mediaType: "application/pdf",
    size: 4096,
    kind: "file",
    path: "/home/thanh/report.pdf",
    ...overrides,
  };
}

describe("model capabilities", () => {
  it("treats an undeclared capability list as image-capable", () => {
    expect(imageAttachEnabled(null)).toBe(true);
    expect(imageAttachEnabled({})).toBe(true);
    expect(imageAttachEnabled({ inputModalities: ["text", "image"] })).toBe(true);
    expect(imageAttachEnabled({ inputModalities: ["text"] })).toBe(false);
  });

  it("recognises images by mime type or extension", () => {
    expect(isImage({ type: "image/webp" })).toBe(true);
    expect(isImage({ type: "", name: "diagram.PNG" })).toBe(true);
    expect(isImage({ type: "application/pdf", name: "report.pdf" })).toBe(false);
    expect(isImage({ type: "text/plain", name: "notes" })).toBe(false);
  });
});

describe("session/prompt content parts", () => {
  it("sends an image as an image part with its media type and base64 payload", () => {
    const { parts, rejected } = buildPromptParts("what is this?", [imageAttachment()], { supportsImages: true });
    expect(rejected).toEqual([]);
    expect(parts).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image", mimeType: "image/png", data: PNG_BASE64 },
    ]);
    // The `data:` URL prefix must not leak into the wire payload.
    expect(JSON.stringify(parts)).not.toContain("data:image/png;base64,");
  });

  it("refuses an image on a text-only model instead of sending a request that 400s", () => {
    const { parts, rejected } = buildPromptParts("hello", [imageAttachment()], { supportsImages: false });
    expect(parts).toEqual([{ type: "text", text: "hello" }]);
    expect(rejected).toEqual([{ name: "shot.png", reason: "the selected model cannot read images" }]);
  });

  it("hands a non-image over as a path plus a read-file hint", () => {
    const { parts } = buildPromptParts("summarise", [fileAttachment()], { supportsImages: true });
    expect(parts[0]).toEqual({ type: "text", text: "summarise" });
    expect(parts[1]).toEqual({
      type: "text",
      text: expect.stringContaining("/home/thanh/report.pdf"),
    });
    expect((parts[1] as { text: string }).text).toContain("read_file");
    expect(parts[2]).toEqual({
      type: "resource_link",
      name: "report.pdf",
      uri: "file:///home/thanh/report.pdf",
      mimeType: "application/pdf",
      size: 4096,
    });
    // The bytes never travel: only the path does.
    expect(JSON.stringify(parts)).not.toMatch(/base64/);
  });

  it("asks for the path when a dropped file has none", () => {
    const { parts } = buildPromptParts("", [fileAttachment({ path: undefined })], { supportsImages: true });
    expect(parts).toHaveLength(1);
    expect((parts[0] as { text: string }).text).toContain("ask the user for the path");
    expect(parts.some((part) => part.type === "resource_link")).toBe(false);
  });

  it("caps image and file sizes with a visible reason", () => {
    const big = buildPromptParts("", [imageAttachment({ size: MAX_IMAGE_BYTES + 1 })], { supportsImages: true });
    expect(big.rejected[0]).toEqual({ name: "shot.png", reason: "image is larger than 5 MB" });
    const huge = buildPromptParts("", [fileAttachment({ size: MAX_FILE_BYTES + 1 })], { supportsImages: true });
    expect(huge.rejected[0]).toEqual({ name: "report.pdf", reason: "file is larger than 25 MB" });
  });

  it("reports an image whose payload was lost rather than sending an empty part", () => {
    const { parts, rejected } = buildPromptParts("", [imageAttachment({ data: undefined })], { supportsImages: true });
    expect(parts).toEqual([]);
    expect(rejected[0].reason).toContain("lost");
  });

  it("sends text alone when nothing is attached", () => {
    expect(buildPromptParts("  only text  ", [], { supportsImages: true })).toEqual({
      parts: [{ type: "text", text: "only text" }],
      rejected: [],
    });
  });
});

describe("attachment construction", () => {
  it("strips the data-url prefix into the base64 payload for images", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const attachment = attachmentFromFile(file, `data:image/png;base64,${PNG_BASE64}`, "/tmp/shot.png");
    expect(attachment.kind).toBe("image");
    expect(attachment.data).toBe(PNG_BASE64);
    expect(attachment.previewUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(attachment.path).toBe("/tmp/shot.png");
  });

  it("keeps a non-image opaque and drops the payload", () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const attachment = attachmentFromFile(file, "data:text/plain;base64,aGVsbG8=", "/tmp/notes.txt");
    expect(attachment.kind).toBe("file");
    expect(attachment.data).toBeUndefined();
    expect(attachment.mediaType).toBe("text/plain");
  });

  it("shows only images in the optimistic transcript turn", () => {
    expect(optimisticImages([imageAttachment(), fileAttachment()])).toEqual([
      `data:image/png;base64,${PNG_BASE64}`,
    ]);
  });
});

describe("path attachments (native picker and OS drop)", () => {
  it("derives a media type from the extension", () => {
    expect(mediaTypeForPath("/tmp/shot.PNG")).toBe("image/png");
    expect(mediaTypeForPath("/tmp/report.pdf")).toBe("application/pdf");
    expect(mediaTypeForPath("/tmp/notes.md")).toBe("text/markdown");
    expect(mediaTypeForPath("/tmp/archive.zip")).toBe("application/octet-stream");
    expect(mediaTypeForPath("/tmp/no-extension")).toBe("application/octet-stream");
  });

  it("keeps a non-image as a path attachment with no bytes", () => {
    const attachment = attachmentFromPath("/home/thanh/report.pdf");
    expect(attachment).toMatchObject({
      name: "report.pdf",
      kind: "file",
      mediaType: "application/pdf",
      path: "/home/thanh/report.pdf",
    });
    expect(attachment.data).toBeUndefined();
    const { parts } = buildPromptParts("", [attachment], { supportsImages: true });
    expect((parts[0] as { text: string }).text).toContain("/home/thanh/report.pdf");
    expect(parts[1]).toMatchObject({ type: "resource_link", uri: "file:///home/thanh/report.pdf" });
  });

  it("inlines an image only when the bytes were read", () => {
    const inline = attachmentFromPath("/home/thanh/shot.png", { data: PNG_BASE64, mediaType: "image/png", size: 4096 });
    expect(inline).toMatchObject({ kind: "image", data: PNG_BASE64, size: 4096 });
    expect(inline.previewUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
    expect(buildPromptParts("", [inline], { supportsImages: true }).parts[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: PNG_BASE64,
    });

    // Unreadable image: it must not become an empty `image` part.
    const unread = attachmentFromPath("/home/thanh/shot.png");
    expect(unread.kind).toBe("file");
    const { parts } = buildPromptParts("", [unread], { supportsImages: true });
    expect(parts.some((part) => part.type === "image")).toBe(false);
    expect((parts[0] as { text: string }).text).toContain("read_file");
  });

  it("names the file from the last path segment", () => {
    expect(attachmentFromPath("/a/b/c notes.txt").name).toBe("c notes.txt");
    expect(attachmentFromPath("C:\\Users\\thanh\\notes.txt").name).toBe("notes.txt");
  });
});
