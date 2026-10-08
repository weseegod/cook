import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkspaceIndexEntry } from "../../../acp/workspace";
import { indexWorkspace } from "../../../acp/workspace";
import { useComposerFileSearch } from "./use-composer-file-search";

vi.mock("../../../acp/workspace", () => ({ indexWorkspace: vi.fn() }));

const walk = vi.mocked(indexWorkspace);

/** One file and one folder, in the order the depth-1 browse puts them. */
const FIRST_FOLDER: WorkspaceIndexEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const OTHER_FOLDER: WorkspaceIndexEntry[] = [{ path: "package.json", kind: "file" }];

const setText = vi.fn();
const textarea = { current: null };

function renderSearch(workspaceRoot: string) {
  return renderHook(
    ({ root }: { root: string }) =>
      useComposerFileSearch({
        text: "@",
        setText,
        textarea,
        workspaceRoot: root,
        slashOpen: false,
        menuClosed: false,
        setMenuClosed: vi.fn(),
      }),
    { initialProps: { root: workspaceRoot } },
  );
}

/** The `@` token only exists once the caret sits after it. */
async function openMenu(result: { current: { onCursor: (cursor: number) => void } }) {
  await act(async () => {
    result.current.onCursor(1);
  });
}

function paths(result: { current: { matches: Array<{ path: string }> } }): string[] {
  return result.current.matches.map((match) => match.path);
}

describe("useComposerFileSearch", () => {
  beforeEach(() => {
    walk.mockReset();
  });

  it("ranks the inventory the host walked for the current folder", async () => {
    walk.mockResolvedValueOnce(FIRST_FOLDER);
    const { result } = renderSearch("/tmp/cook-demo");

    await openMenu(result);
    await waitFor(() => expect(paths(result)).toEqual(["src", "README.md"]));
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it("drops the previous folder's paths and walks the new one", async () => {
    let resolveOther: (entries: WorkspaceIndexEntry[]) => void = () => {};
    const other = new Promise<WorkspaceIndexEntry[]>((resolve) => {
      resolveOther = resolve;
    });
    walk.mockResolvedValueOnce(FIRST_FOLDER).mockReturnValueOnce(other);
    const { result, rerender } = renderSearch("/tmp/cook-demo");

    await openMenu(result);
    await waitFor(() => expect(paths(result)).toEqual(["src", "README.md"]));

    rerender({ root: "/tmp/other-project" });
    await waitFor(() => expect(paths(result)).toEqual([]));

    resolveOther(OTHER_FOLDER);
    await waitFor(() => expect(paths(result)).toEqual(["package.json"]));
    expect(walk).toHaveBeenCalledTimes(2);
  });
});
