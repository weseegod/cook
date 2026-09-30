import { describe, expect, it } from "vitest";
import { extractPlanChecklist, planEntryStatus, planEntryText } from "./plan-entries";

describe("plan entries", () => {
  it("reads text from an ACP entry and from looser shapes", () => {
    expect(planEntryText({ content: "Map the goal surface", priority: "high", status: "pending" })).toBe("Map the goal surface");
    expect(planEntryText("plain body line")).toBe("plain body line");
    expect(planEntryText({ title: "Titled" })).toBe("Titled");
    expect(planEntryText(null)).toBe("");
  });

  it("maps ACP statuses and treats an unknown one as pending", () => {
    expect(planEntryStatus({ content: "a", status: "pending" })).toBe("pending");
    expect(planEntryStatus({ content: "b", status: "in_progress" })).toBe("in_progress");
    expect(planEntryStatus({ content: "c", status: "completed" })).toBe("completed");
    expect(planEntryStatus({ content: "d", status: "in-progress" })).toBe("in_progress");
    expect(planEntryStatus({ content: "e" })).toBe("pending");
    expect(planEntryStatus("a bare line")).toBe("pending");
  });

  it("detects the cancelled flag ACP smuggles through `_meta`", () => {
    // ACP has no cancelled status: the agent sends `completed` plus `_meta.cancelled`.
    expect(planEntryStatus({ content: "dropped", status: "completed", _meta: { cancelled: true } })).toBe("cancelled");
    expect(planEntryStatus({ content: "dropped", status: "completed", meta: { cancelled: true } })).toBe("cancelled");
    expect(planEntryStatus({ content: "done", status: "completed", _meta: { cancelled: false } })).toBe("completed");
  });

  it("extracts checked and unchecked tasks only from the canonical section", () => {
    const body = `# Plan: Ship a board

## Acceptance criteria
- [ ] acceptance is not a task

## Task checklist
- [x] \`index.html\` — create the page. Done when: it loads.
### Later work
* [ ] \`app.js\` — wire controls. Done when: it responds.
+ [X] verify output

## Notes
- [ ] unrelated checkbox`;
    expect(extractPlanChecklist(body)).toEqual([
      { content: "`index.html` — create the page. Done when: it loads.", status: "completed" },
      { content: "`app.js` — wire controls. Done when: it responds.", status: "pending" },
      { content: "verify output", status: "completed" },
    ]);
  });

  it("reads saved passive Steps when Task checklist is absent", () => {
    expect(extractPlanChecklist("# Plan\n\n## Steps\n- [ ] build the board\n- [X] write the tests\n")).toEqual([
      { content: "build the board", status: "pending" },
      { content: "write the tests", status: "completed" },
    ]);
    expect(extractPlanChecklist("## Steps\n- [ ] old\n## Task checklist\n- [ ] current\n")).toEqual([
      { content: "current", status: "pending" },
    ]);
  });

  it("returns no tasks without valid checklist rows", () => {
    expect(extractPlanChecklist(null)).toEqual([]);
    expect(extractPlanChecklist("## Acceptance criteria\n- [ ] unrelated")).toEqual([]);
    expect(extractPlanChecklist("## Task checklist\n- plain bullet\n## Notes\n- [ ] unrelated")).toEqual([]);
  });
});
