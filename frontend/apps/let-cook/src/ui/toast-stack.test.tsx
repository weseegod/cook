import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../state/session";
import { ToastStack } from "./toast-stack";

beforeEach(() => {
  useSessionStore.setState({ sessionId: "open", toasts: [] });
});

afterEach(cleanup);

describe("ToastStack", () => {
  it("renders nothing while there is no message", () => {
    const { container } = render(<ToastStack onOpenSession={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers to open the conversation a message came from", () => {
    const onOpenSession = vi.fn();
    useSessionStore.getState().pushToast({
      tone: "success",
      title: "Turn completed",
      body: "A conversation finished while you were away.",
      sessionId: "elsewhere",
    });
    render(<ToastStack onOpenSession={onOpenSession} />);

    expect(screen.getByTestId("toast-stack")).toHaveTextContent("Turn completed");
    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onOpenSession).toHaveBeenCalledWith("elsewhere");
    expect(useSessionStore.getState().toasts).toEqual([]);
  });

  it("hides Open for the conversation already on screen", () => {
    useSessionStore.getState().pushToast({ tone: "info", title: "Copied path", sessionId: "open" });
    render(<ToastStack onOpenSession={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss message" })).toBeInTheDocument();
  });

  it("dismisses a message on demand", () => {
    useSessionStore.getState().pushToast({ tone: "error", title: "Turn failed", sticky: true });
    render(<ToastStack onOpenSession={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Dismiss message" }));
    expect(useSessionStore.getState().toasts).toEqual([]);
  });
});
