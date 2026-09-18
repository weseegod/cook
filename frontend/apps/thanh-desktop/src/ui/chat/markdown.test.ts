import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

const markdownSpy = vi.hoisted(() => ({ renders: 0 }));

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: ReactNode }) => {
    markdownSpy.renders += 1;
    return createElement("div", { "data-testid": "mock-markdown" }, children);
  },
}));

import { Markdown, splitStreamingMarkdown } from "./markdown";

describe("streaming markdown checkpoints", () => {
  it("freezes the prefix at the last paragraph boundary", () => {
    expect(splitStreamingMarkdown("first paragraph\n\nlive tail")).toEqual({
      prefix: "first paragraph\n\n",
      tail: "live tail",
    });
  });

  it("does not re-parse the frozen prefix while only the tail grows", () => {
    markdownSpy.renders = 0;
    const view = render(createElement(Markdown, { text: "stable\n\npartial", streaming: true }));
    expect(markdownSpy.renders).toBe(1);

    view.rerender(createElement(Markdown, { text: "stable\n\npartial tail", streaming: true }));
    expect(markdownSpy.renders).toBe(1);

    view.rerender(createElement(Markdown, { text: "stable\n\npartial tail" }));
    expect(markdownSpy.renders).toBe(2);
  });
});
