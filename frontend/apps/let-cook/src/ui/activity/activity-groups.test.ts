import { describe, expect, it } from "vitest";
import type { ActivityItem } from "../../state/activity";
import { groupActivityRows, groupOf } from "./activity-groups";

const item = (patch: Partial<ActivityItem> & Pick<ActivityItem, "id" | "kind">): ActivityItem => ({
  name: patch.id,
  status: "running",
  startedAt: 0,
  ...patch,
});

describe("activity groups", () => {
  it("buckets rows into the pane's sections, keeping its order", () => {
    const rows = [
      item({ id: "t-1", kind: "task" }),
      item({ id: "t-2", kind: "task", isMonitor: true }),
      item({ id: "sa-1", kind: "subagent" }),
      item({ id: "sc-1", kind: "schedule" }),
      item({ id: "wf-1", kind: "workflow" }),
    ];
    expect(groupActivityRows(rows).map((group) => [group.kind, group.rows.map((row) => row.id)])).toEqual([
      ["workflows", ["wf-1"]],
      ["subagents", ["sa-1"]],
      ["tasks", ["t-1"]],
      ["watchers", ["t-2", "sc-1"]],
    ]);
  });

  it("drops the sections with nothing in them", () => {
    expect(groupActivityRows([item({ id: "t-1", kind: "task" })]).map((group) => group.kind)).toEqual(["tasks"]);
  });

  it("sends monitors and loops to the watchers section", () => {
    expect(groupOf(item({ id: "m", kind: "task", isMonitor: true }))).toBe("watchers");
    expect(groupOf(item({ id: "s", kind: "schedule" }))).toBe("watchers");
    expect(groupOf(item({ id: "w", kind: "workflow" }))).toBe("workflows");
    expect(groupOf(item({ id: "a", kind: "subagent" }))).toBe("subagents");
  });
});
