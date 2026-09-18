import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpClient, elicitInteraction } from "../../acp/client";
import { useSessionStore, type PendingQuestion } from "../../state/session";
import { InteractionModal } from "./interaction-modal";

const FORM_REQUEST = {
  sessionId: "s1",
  toolCallId: "t1",
  serverName: "filesystem",
  message: "Which directory should I expose?",
  mode: "form",
  requestedSchema: {
    type: "object",
    properties: {
      path: { type: "string", title: "Directory" },
      depth: { type: "integer", title: "Depth" },
    },
    required: ["path"],
  },
};

function show(question: PendingQuestion) {
  useSessionStore.setState({ pendingQuestion: question });
  return render(<InteractionModal />);
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ pendingQuestion: null });
  vi.restoreAllMocks();
});

describe("elicitInteraction", () => {
  it("names the asking connector and describes the input it needs", () => {
    const card = elicitInteraction(7, FORM_REQUEST);
    expect(card.kind).toBe("elicit");
    expect(card.rpcId).toBe(7);
    expect(card.title).toBe("filesystem needs your input");
    expect(card.questions[0].question).toBe("Which directory should I expose?");
    expect(card.questions[0].options.map((option) => option.id)).toEqual(["accept", "decline"]);
  });

  it("shows the URL a url-mode visit points at", () => {
    const card = elicitInteraction(8, { serverName: "linear", message: "Authorize the app", mode: "url", url: "https://linear.app/oauth" });
    expect(card.questions[0].question).toContain("https://linear.app/oauth");
    expect(card.questions[0].options[0].label).toBe("Open and continue");
  });
});

describe("plan review card", () => {
  // Plan review verdicts live only on PlanDialog — InteractionModal returns null for plan.
  const REVIEW: PendingQuestion = {
    rpcId: 21,
    kind: "plan",
    raw: { planContent: "# Implementation plan\n" },
    questions: [{
      question: "Waiting on plan approval",
      options: [
        { id: "approved", label: "Approve" },
        { id: "approved_as_goal", label: "Run as goal" },
        { id: "cancelled", label: "Request changes" },
        { id: "abandoned", label: "Quit plan" },
      ],
    }],
  };

  it("does not render an inline card for a parked plan review", () => {
    show(REVIEW);
    expect(screen.queryByTestId("inline-interaction")).toBeNull();
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});

describe("elicitation card", () => {
  it("renders one control per requested field", () => {
    show(elicitInteraction(11, FORM_REQUEST));
    expect(screen.getByTestId("elicit-fields")).toBeTruthy();
    expect(screen.getByTestId("elicit-path")).toBeTruthy();
    expect(screen.getByTestId("elicit-depth")).toBeTruthy();
  });

  it("answers with the typed values, coerced to the declared types", async () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    show(elicitInteraction(11, FORM_REQUEST));
    fireEvent.change(screen.getByTestId("elicit-path"), { target: { value: "/home/demo" } });
    fireEvent.change(screen.getByTestId("elicit-depth"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("elicit-accept"));
    expect(answer).toHaveBeenCalledWith({ outcome: "accept", content: { path: "/home/demo", depth: 2 } });
  });

  it("holds accept back until the required field is filled", () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    show(elicitInteraction(11, FORM_REQUEST));
    const accept = screen.getByTestId("elicit-accept") as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    fireEvent.click(accept);
    expect(answer).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("elicit-path"), { target: { value: "/tmp" } });
    expect((screen.getByTestId("elicit-accept") as HTMLButtonElement).disabled).toBe(false);
  });

  it("lets the user decline, and cancels on close", () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    const decline = show(elicitInteraction(11, FORM_REQUEST));
    fireEvent.click(screen.getByTestId("elicit-decline"));
    expect(answer).toHaveBeenCalledWith({ outcome: "decline" });
    answer.mockClear();
    decline.unmount();
    show(elicitInteraction(12, FORM_REQUEST));
    fireEvent.click(screen.getByTestId("interaction-close"));
    expect(answer).toHaveBeenCalledWith({ outcome: "cancel" });
  });

  it("cancels the active interaction with Escape", () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    show(elicitInteraction(14, FORM_REQUEST));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(answer).toHaveBeenCalledWith({ outcome: "cancel" });
  });

  it("asks nothing for a url-mode visit", () => {
    show(elicitInteraction(13, { serverName: "linear", message: "Authorize", mode: "url", url: "https://linear.app/oauth" }));
    expect(screen.queryByTestId("elicit-fields")).toBeNull();
    expect(screen.getByTestId("elicit-accept").textContent).toContain("Open and continue");
  });
});
