import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acpClient } from "../../acp/client";
import { elicitInteraction, questionInteraction, splitQuestionLabelDesc } from "../../acp/reverse";
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

const SAME_TEXT = "Which approach should I use?";

const MULTI_ASK = questionInteraction(42, {
  questions: [
    {
      question: `${SAME_TEXT}\n\nPrefer the safer path unless speed is mandatory.`,
      multiSelect: false,
      options: [
        { id: "safe", label: "Safe change", description: "Smallest diff" },
        { id: "fast", label: "Fast change", description: "Ship quickly" },
      ],
    },
    {
      question: SAME_TEXT,
      multiSelect: true,
      options: [
        { id: "tests", label: "Add tests" },
        { id: "docs", label: "Update docs" },
        { id: "skip", label: "Skip extras" },
      ],
    },
    {
      question: "Where should we deploy?",
      options: [
        { id: "staging", label: "Staging" },
        { id: "prod", label: "Production" },
      ],
    },
  ],
});

function show(question: PendingQuestion) {
  useSessionStore.setState({ pendingQuestion: question });
  return render(<InteractionModal />);
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ pendingQuestion: null });
  vi.restoreAllMocks();
});

describe("splitQuestionLabelDesc", () => {
  it("keeps the full text as the label when there is no blank line", () => {
    expect(splitQuestionLabelDesc("Which database engine?")).toEqual({
      label: "Which database engine?",
      description: "",
    });
  });

  it("splits on the first blank line", () => {
    expect(splitQuestionLabelDesc("Which database?\n\nPick the engine for the backend.")).toEqual({
      label: "Which database?",
      description: "Pick the engine for the backend.",
    });
  });
});

describe("questionInteraction", () => {
  it("stores label, description, and index on each question", () => {
    expect(MULTI_ASK.questions[0]).toMatchObject({
      index: 0,
      label: SAME_TEXT,
      description: "Prefer the safer path unless speed is mandatory.",
    });
    expect(MULTI_ASK.questions[1]).toMatchObject({
      index: 1,
      label: SAME_TEXT,
      question: SAME_TEXT,
    });
    expect(MULTI_ASK.questions[1].description).toBeUndefined();
  });
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
      label: "Waiting on plan approval",
      index: 0,
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

describe("question card tabs", () => {
  it("renders a 1 / 3 counter and shows only the active question label", () => {
    show(MULTI_ASK);
    expect(screen.getByTestId("question-tab-counter").textContent).toMatch(/1\s*\/\s*3/);
    expect(screen.getByTestId("question-label").textContent).toContain(SAME_TEXT);
    expect(screen.getByTestId("question-description").textContent).toContain("Prefer the safer path");
    expect(screen.getByTestId("question-option-0-safe")).toBeTruthy();
    expect(screen.queryByTestId("question-option-1-tests")).toBeNull();

    fireEvent.click(screen.getByTestId("question-tab-2"));
    expect(screen.getByTestId("question-tab-counter").textContent).toMatch(/2\s*\/\s*3/);
    expect(screen.getByTestId("question-panel-2")).toBeTruthy();
    expect(screen.getByTestId("question-option-1-tests")).toBeTruthy();
    expect(screen.queryByTestId("question-option-0-safe")).toBeNull();
    expect(screen.queryByTestId("question-description")).toBeNull();
  });

  it("keeps separate selections for two questions with the same text", async () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    show(MULTI_ASK);

    fireEvent.click(screen.getByTestId("question-option-0-safe"));
    fireEvent.click(screen.getByTestId("question-tab-2"));
    fireEvent.click(screen.getByTestId("question-option-1-tests"));
    fireEvent.click(screen.getByTestId("question-option-1-docs"));
    fireEvent.click(screen.getByTestId("question-tab-3"));
    fireEvent.click(screen.getByTestId("question-option-2-staging"));
    fireEvent.click(screen.getByTestId("question-submit"));

    expect(answer).toHaveBeenCalledWith({
      outcome: "accepted",
      answers: {
        [`${SAME_TEXT}\n\nPrefer the safer path unless speed is mandatory.`]: ["Safe change"],
        [SAME_TEXT]: ["Add tests", "Update docs"],
        "Where should we deploy?": ["Staging"],
      },
    });
  });

  it("keeps freeform text on one question out of another question's answer", async () => {
    const answer = vi.spyOn(acpClient, "answerQuestion").mockResolvedValue();
    show(MULTI_ASK);

    fireEvent.change(screen.getByTestId("question-other-0"), { target: { value: "custom for q1" } });
    fireEvent.click(screen.getByTestId("question-tab-2"));
    expect((screen.getByTestId("question-other-1") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByTestId("question-option-1-tests"));
    fireEvent.click(screen.getByTestId("question-tab-3"));
    fireEvent.click(screen.getByTestId("question-option-2-prod"));
    fireEvent.click(screen.getByTestId("question-submit"));

    expect(answer).toHaveBeenCalledWith({
      outcome: "accepted",
      answers: {
        [`${SAME_TEXT}\n\nPrefer the safer path unless speed is mandatory.`]: ["Other"],
        [SAME_TEXT]: ["Add tests"],
        "Where should we deploy?": ["Production"],
      },
      annotations: {
        [`${SAME_TEXT}\n\nPrefer the safer path unless speed is mandatory.`]: { notes: "custom for q1" },
      },
    });
  });

  it("toggles multi-select and replaces single-select", () => {
    show(MULTI_ASK);
    const safe = screen.getByTestId("question-option-0-safe");
    fireEvent.click(safe);
    expect(safe.className).toContain("selected");
    fireEvent.click(screen.getByTestId("question-option-0-fast"));
    expect(safe.className).not.toContain("selected");
    expect(screen.getByTestId("question-option-0-fast").className).toContain("selected");
    // deselect
    fireEvent.click(screen.getByTestId("question-option-0-fast"));
    expect(screen.getByTestId("question-option-0-fast").className).not.toContain("selected");

    fireEvent.click(screen.getByTestId("question-tab-2"));
    fireEvent.click(screen.getByTestId("question-option-1-tests"));
    fireEvent.click(screen.getByTestId("question-option-1-docs"));
    expect(screen.getByTestId("question-option-1-tests").className).toContain("selected");
    expect(screen.getByTestId("question-option-1-docs").className).toContain("selected");
    fireEvent.click(screen.getByTestId("question-option-1-tests"));
    expect(screen.getByTestId("question-option-1-tests").className).not.toContain("selected");
  });

  it("shows option descriptions inline and the answered hint", () => {
    show(MULTI_ASK);
    expect(within(screen.getByTestId("question-option-0-safe")).getByText("Smallest diff")).toBeTruthy();
    expect(screen.getByTestId("question-answered-hint").textContent).toMatch(/0\s*\/\s*3 answered/);
    expect((screen.getByTestId("question-submit") as HTMLButtonElement).disabled).toBe(true);
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
