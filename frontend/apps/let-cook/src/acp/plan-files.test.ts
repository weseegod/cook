import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./host", () => ({
  request: vi.fn(async () => ({})),
}));

import { request } from "./host";
import { deletePlanFile, listPlanFiles } from "./plan-files";

const params = { sessionId: "sess-1", cwd: "/work" };

describe("listPlanFiles", () => {
  beforeEach(() => vi.mocked(request).mockClear());

  it("asks the agent for the session's plan files", async () => {
    vi.mocked(request).mockResolvedValue({ plans: [] });

    await listPlanFiles(params);

    expect(request).toHaveBeenCalledWith("x.ai/session/plans", { sessionId: "sess-1", cwd: "/work" });
  });

  it("normalizes a full payload", async () => {
    vi.mocked(request).mockResolvedValue({
      plans: [{
        name: "2026-09-19T14-30-22Z.md",
        path: "/home/u/.cook/sessions/p/sess-1/plans/2026-09-19T14-30-22Z.md",
        relativePath: "plans/2026-09-19T14-30-22Z.md",
        sizeBytes: 1368,
        modifiedMs: 1758292222000,
        active: true,
        deletable: false,
        content: "# Current plan",
      }],
    });

    expect(await listPlanFiles(params)).toEqual([{
      name: "2026-09-19T14-30-22Z.md",
      path: "/home/u/.cook/sessions/p/sess-1/plans/2026-09-19T14-30-22Z.md",
      relativePath: "plans/2026-09-19T14-30-22Z.md",
      sizeBytes: 1368,
      modifiedMs: 1758292222000,
      active: true,
      deletable: false,
      content: "# Current plan",
    }]);
  });

  it("accepts snake_case fields and fills in what a payload omits", async () => {
    vi.mocked(request).mockResolvedValue({
      plans: [{ name: "plan.md", size_bytes: 12, relative_path: "plan.md", modified_ms: 1, active: false }],
    });

    const [file] = await listPlanFiles(params);

    expect(file).toEqual({
      name: "plan.md",
      path: "",
      relativePath: "plan.md",
      sizeBytes: 12,
      modifiedMs: 1,
      active: false,
      // A payload without the flag still offers Delete rather than a dead button.
      deletable: true,
      content: null,
    });
  });

  it("drops entries without a name and non-object shapes", async () => {
    vi.mocked(request).mockResolvedValue({ plans: [null, "plan.md", { path: "/p/plan.md" }, { name: "ok.md" }] });

    expect((await listPlanFiles(params)).map((file) => file.name)).toEqual(["ok.md"]);
  });

  it("reports no plans when the agent answers with an unexpected shape", async () => {
    vi.mocked(request).mockResolvedValue("nope");

    expect(await listPlanFiles(params)).toEqual([]);
  });
});

describe("deletePlanFile", () => {
  beforeEach(() => vi.mocked(request).mockClear());

  it("sends the absolute path and reports success", async () => {
    vi.mocked(request).mockResolvedValue({ deleted: true });

    expect(await deletePlanFile({ ...params, path: "/p/plans/old.md" })).toBe(true);
    expect(request).toHaveBeenCalledWith("x.ai/session/plans/delete", {
      sessionId: "sess-1",
      cwd: "/work",
      path: "/p/plans/old.md",
    });
  });

  it("throws when the agent refused the delete", async () => {
    vi.mocked(request).mockResolvedValue({ deleted: false });

    await expect(deletePlanFile({ ...params, path: "/p/plans/current.md" })).rejects.toThrow("The plan was not deleted");
  });
});
