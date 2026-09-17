import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { PermissionModal } from "./permission-modal";

afterEach(() => {
  cleanup();
  useSessionStore.setState({ pendingPermission: null });
  vi.restoreAllMocks();
});

function showPermission() {
  useSessionStore.setState({
    pendingPermission: {
      rpcId: 4,
      request: {
        sessionId: "s1",
        toolCall: { toolCallId: "t1", title: "Run pnpm test", kind: "execute", content: [{ type: "content", content: { type: "text", text: "pnpm test" } }] },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    },
  });
  return render(<PermissionModal />);
}

describe("inline permission card", () => {
  it("renders in the transcript without a modal backdrop", () => {
    showPermission();
    expect(screen.getByTestId("inline-permission")).toBeTruthy();
    expect(document.querySelector(".modal-backdrop")).toBeNull();
  });

  it("supports the numbered desktop shortcut", () => {
    const answer = vi.spyOn(acpClient, "answerPermission").mockResolvedValue();
    showPermission();
    fireEvent.keyDown(document, { key: "1" });
    expect(answer).toHaveBeenCalledWith("allow-once");
  });
});
