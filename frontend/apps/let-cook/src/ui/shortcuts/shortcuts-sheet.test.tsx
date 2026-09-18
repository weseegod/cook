import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SHORTCUT_BINDINGS, ShortcutsSheet } from "./shortcuts-sheet";

afterEach(() => cleanup());

describe("shortcuts sheet", () => {
  it("lists the expected bindings", () => {
    render(<ShortcutsSheet onClose={() => undefined} />);
    expect(screen.getByTestId("shortcuts-sheet")).toBeTruthy();
    for (const binding of SHORTCUT_BINDINGS) {
      const row = screen.getByTestId(`shortcut-${binding.id}`);
      expect(row).toHaveTextContent(binding.label);
      for (const key of binding.keys) {
        expect(row).toHaveTextContent(key);
      }
    }
    expect(SHORTCUT_BINDINGS.map((b) => b.id)).toEqual([
      "palette",
      "new-chat",
      "settings",
      "plan",
      "stop",
      "yolo",
      "review",
      "files",
    ]);
  });
});
