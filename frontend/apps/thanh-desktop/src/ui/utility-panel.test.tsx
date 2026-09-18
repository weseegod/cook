import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  listWorkspace: vi.fn(),
  loadWorkspaceReview: vi.fn(),
  readWorkspaceFile: vi.fn(),
  openWorkspacePath: vi.fn(),
}));

vi.mock("../acp/workspace", () => ({
  ...workspace,
  fileExtension: (path: string) => path.split(".").pop() ?? "text",
  formatBytes: (size: number | null | undefined) => size == null ? "" : `${size} B`,
}));

import { UtilityPanel } from "./utility-panel";

beforeEach(() => {
  workspace.loadWorkspaceReview.mockResolvedValue({ base: "HEAD", isGitRepo: true, branch: "main", additions: 1, deletions: 0, files: [{ path: "src/main.tsx", status: "modified", additions: 1, deletions: 0, diff: "+ready" }] });
  workspace.listWorkspace.mockResolvedValue([{ name: "src", path: "src", kind: "directory", size: null }]);
  workspace.readWorkspaceFile.mockResolvedValue({ path: "src/main.tsx", content: "ready", size: 5, truncated: false, binary: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("utility panel", () => {
  it("opens the Review, Files, and Activity views", async () => {
    render(<UtilityPanel onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /^Review/ }));
    await waitFor(() => expect(screen.getByTestId("review-view")).toBeInTheDocument());
    expect(screen.getByTestId("diff-preview")).toHaveTextContent("src/main.tsx");

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByRole("button", { name: /^Files/ }));
    await waitFor(() => expect(screen.getByTestId("files-view")).toBeInTheDocument());
    expect(workspace.listWorkspace).toHaveBeenCalledWith("");

    fireEvent.click(screen.getByRole("button", { name: "Tools" }));
    fireEvent.click(screen.getByRole("button", { name: /^Activity/ }));
    await waitFor(() => expect(screen.getByTestId("activity-view")).toBeInTheDocument());
  });
});
