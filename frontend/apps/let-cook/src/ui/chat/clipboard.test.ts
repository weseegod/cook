import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/host", () => ({
  desktopCommand: vi.fn(async (_command: string, _args: unknown, fallback: () => Promise<unknown>) =>
    // Unit tests run outside Tauri, so desktopCommand always takes the fallback.
    fallback(),
  ),
  isTauriRuntime: vi.fn(() => false),
}));

import { desktopCommand, isTauriRuntime } from "../../acp/host";
import { copyText } from "./clipboard";

describe("copyText", () => {
  beforeEach(() => {
    vi.mocked(desktopCommand).mockClear();
    vi.mocked(isTauriRuntime).mockReset();
    vi.mocked(isTauriRuntime).mockReturnValue(false);
    document.execCommand = vi.fn(() => true);
  });

  it("uses navigator.clipboard when it accepts the write", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await copyText("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand when the webview denies clipboard-write", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new DOMException(
            "The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.",
            "NotAllowedError",
          );
        }),
      },
      configurable: true,
    });

    await copyText("/tmp/sessions/demo");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(desktopCommand).not.toHaveBeenCalled();
  });

  it("uses the host command when selection copy also fails on Tauri", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {
          throw new DOMException("denied", "NotAllowedError");
        }),
      },
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    vi.mocked(desktopCommand).mockImplementationOnce(async (_command, _args, fallback) =>
      fallback(),
    );

    await expect(copyText("path")).rejects.toThrow("Clipboard is unavailable");
    expect(desktopCommand).toHaveBeenCalledWith(
      "clipboard_write",
      { text: "path" },
      expect.any(Function),
    );
  });

  it("rejects empty text", async () => {
    await expect(copyText("")).rejects.toThrow("Nothing to copy");
  });
});
