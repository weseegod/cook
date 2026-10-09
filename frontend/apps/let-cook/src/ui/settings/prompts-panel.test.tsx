import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/extensions", () => ({
  listPrompts: vi.fn(),
  readPrompt: vi.fn(),
  writePrompt: vi.fn(),
  restorePrompt: vi.fn(),
}));

import {
  listPrompts,
  readPrompt,
  restorePrompt,
  writePrompt,
  type PromptEntryView,
} from "../../acp/extensions";
import { PromptsPanel } from "./prompts-panel";

const ENTRIES: PromptEntryView[] = [
  { relative: "plan/contract.md", path: "/home/demo/.cook/prompts/plan/contract.md", state: "modified" },
  { relative: "subagent/explore.md", path: "/home/demo/.cook/prompts/subagent/explore.md", state: "absent" },
];

function renderPanel(connected = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PromptsPanel connected={connected} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(listPrompts).mockReset().mockResolvedValue({
    root: "/home/demo/.cook/prompts",
    prompts: ENTRIES,
  });
  vi.mocked(readPrompt).mockReset().mockResolvedValue({
    relative: "plan/contract.md",
    path: "/home/demo/.cook/prompts/plan/contract.md",
    state: "modified",
    content: "my edited plan reminder\n",
    default: "the shipped reminder",
  });
  vi.mocked(writePrompt).mockReset().mockResolvedValue({ relative: "plan/contract.md", state: "modified" });
  vi.mocked(restorePrompt).mockReset().mockResolvedValue({ relative: "plan/contract.md", state: "unmodified" });
});

afterEach(cleanup);

describe("PromptsPanel", () => {
  it("lists every prompt with its copy state", async () => {
    renderPanel();

    expect(await screen.findByText("plan/contract.md")).toBeInTheDocument();
    expect(screen.getByText("subagent/explore.md")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-open-plan/contract.md")).toHaveTextContent("Modified");
    expect(screen.getByTestId("prompt-open-subagent/explore.md")).toHaveTextContent("No copy");
  });

  it("warns that edits are global and placeholders are load-bearing", async () => {
    renderPanel();

    expect(await screen.findByTestId("prompts-summary")).toHaveTextContent("every session");
    const warning = screen.getByTestId("prompts-warning");
    expect(warning).toHaveTextContent("Reset");
    expect(warning).toHaveTextContent("${...}");
  });

  it("reads a prompt and shows the user's text", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("prompt-open-plan/contract.md"));

    await waitFor(() => expect(vi.mocked(readPrompt)).toHaveBeenCalledWith("plan/contract.md"));
    expect(await screen.findByTestId("prompt-text")).toHaveTextContent("my edited plan reminder");
    expect(screen.getByTestId("prompt-state")).toHaveTextContent("Modified");
  });

  it("seeds the editor with the compiled default when there is no user copy", async () => {
    vi.mocked(readPrompt).mockResolvedValue({
      relative: "subagent/explore.md",
      path: "/home/demo/.cook/prompts/subagent/explore.md",
      state: "absent",
      content: null,
      default: "you are a read-only explorer",
    });
    renderPanel();

    fireEvent.click(await screen.findByTestId("prompt-open-subagent/explore.md"));
    await waitFor(() => expect(screen.getByTestId("prompt-reset")).toBeDisabled());
    await waitFor(() => expect(screen.getByTestId("prompt-edit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("prompt-edit"));

    expect((await screen.findByTestId("prompt-editor")) as HTMLTextAreaElement).toHaveValue(
      "you are a read-only explorer",
    );
  });

  it("saves the edited text and reports the result", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("prompt-open-plan/contract.md"));
    await waitFor(() => expect(screen.getByTestId("prompt-edit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("prompt-edit"));
    fireEvent.change(await screen.findByTestId("prompt-editor"), { target: { value: "new text" } });
    fireEvent.click(screen.getByTestId("prompt-save"));

    await waitFor(() => expect(vi.mocked(writePrompt)).toHaveBeenCalledWith("plan/contract.md", "new text"));
    expect(await screen.findByTestId("prompt-status")).toHaveTextContent("Saved");
  });

  it("resets only after confirming, and reports the shipped text is back", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("prompt-open-plan/contract.md"));
    await waitFor(() => expect(screen.getByTestId("prompt-reset")).toBeEnabled());
    fireEvent.click(screen.getByTestId("prompt-reset"));

    expect(vi.mocked(restorePrompt)).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("prompt-reset-confirm"));

    await waitFor(() => expect(vi.mocked(restorePrompt)).toHaveBeenCalledWith("plan/contract.md"));
    expect(await screen.findByTestId("prompt-status")).toHaveTextContent("Reset");
  });

  it("cannot edit before the agent is connected", () => {
    renderPanel(false);

    expect(screen.queryByTestId("prompt-open-plan/contract.md")).toBeNull();
    expect(screen.getByText("Connect the agent to edit prompt files.")).toBeInTheDocument();
    expect(vi.mocked(listPrompts)).not.toHaveBeenCalled();
  });
});
