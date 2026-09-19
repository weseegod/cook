import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../acp/client", () => ({
  acpClient: { xai: { deleteAllSessions: vi.fn() } },
}));

import { acpClient } from "../../acp/client";
import { useSessionStore } from "../../state/session";
import { DEFAULT_PREFS, loadPrefs, savePrefs } from "../sessions/session-sidebar-utils";
import { DataControlsPanel } from "./data-controls";

function renderPanel(connected = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DataControlsPanel connected={connected} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(acpClient.xai.deleteAllSessions).mockReset();
  vi.mocked(acpClient.xai.deleteAllSessions).mockResolvedValue({ deleted: 2, plansDeleted: 3, failed: 0 });
  localStorage.clear();
  useSessionStore.setState({ sessionId: "sess-1", cwd: "/work", notice: null, error: null });
});

afterEach(cleanup);

describe("DataControlsPanel", () => {
  it("asks before erasing anything", () => {
    renderPanel();

    fireEvent.click(screen.getByTestId("delete-all-conversations"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Delete all conversations?");
    expect(dialog).toHaveTextContent("plan files");
    expect(vi.mocked(acpClient.xai.deleteAllSessions)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(vi.mocked(acpClient.xai.deleteAllSessions)).not.toHaveBeenCalled();
  });

  it("erases every conversation on confirm and reports what went", async () => {
    renderPanel();
    fireEvent.click(screen.getByTestId("delete-all-conversations"));
    fireEvent.click(screen.getByTestId("delete-all-confirm"));

    await waitFor(() => expect(vi.mocked(acpClient.xai.deleteAllSessions)).toHaveBeenCalledTimes(1));

    expect(useSessionStore.getState().notice).toBe("Deleted 2 conversations and 3 plan files.");
    // The open conversation went with the rest, so the window drops it.
    expect(useSessionStore.getState().sessionId).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drops the pinned and ordered rows that pointed at the erased conversations", async () => {
    savePrefs({ ...DEFAULT_PREFS, pinned: ["sess-1"], order: ["sess-1", "sess-2"] });
    renderPanel();

    fireEvent.click(screen.getByTestId("delete-all-conversations"));
    fireEvent.click(screen.getByTestId("delete-all-confirm"));

    await waitFor(() => expect(loadPrefs().pinned).toEqual([]));
    expect(loadPrefs().order).toEqual([]);
  });

  it("says how many conversations it could not delete", async () => {
    vi.mocked(acpClient.xai.deleteAllSessions).mockResolvedValue({ deleted: 3, plansDeleted: 4, failed: 2 });
    renderPanel();

    fireEvent.click(screen.getByTestId("delete-all-conversations"));
    fireEvent.click(screen.getByTestId("delete-all-confirm"));

    await waitFor(() =>
      expect(useSessionStore.getState().error).toBe(
        "Deleted 3 conversations and 4 plan files; 2 could not be deleted.",
      ),
    );
    expect(useSessionStore.getState().notice).toBeNull();
  });

  it("keeps the confirmation open with the agent's error", async () => {
    vi.mocked(acpClient.xai.deleteAllSessions).mockRejectedValue(new Error("agent offline"));
    renderPanel();

    fireEvent.click(screen.getByTestId("delete-all-conversations"));
    fireEvent.click(screen.getByTestId("delete-all-confirm"));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("agent offline"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(useSessionStore.getState().sessionId).toBe("sess-1");
  });

  it("cannot run before the agent is connected", () => {
    renderPanel(false);

    const button = screen.getByTestId("delete-all-conversations");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Connect the agent first");
  });
});
