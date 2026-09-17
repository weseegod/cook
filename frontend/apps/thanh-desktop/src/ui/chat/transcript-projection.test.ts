import { describe, expect, it } from "vitest";
import type { MessageBlock, ToolBlock, TranscriptBlock } from "../../state/session";
import { activityLabel, projectTranscript } from "./transcript-projection";

const tool = (id: string, title: string, status = "completed"): ToolBlock => ({
  type: "tool",
  id,
  turnId: "turn-1",
  title,
  kind: title,
  status,
  content: [],
  locations: [],
});

const thought: MessageBlock = {
  type: "message",
  id: "thought-1",
  turnId: "turn-1",
  role: "thought",
  text: "Inspecting the repository",
  images: [],
  streaming: false,
};

describe("transcript projection", () => {
  it("folds contiguous thoughts and tools into one activity", () => {
    const blocks: TranscriptBlock[] = [thought, tool("read-1", "Read src/a.ts"), tool("read-2", "Read src/b.ts")];
    const projected = projectTranscript(blocks);
    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ type: "activity", tools: [{ id: "read-1" }, { id: "read-2" }] });
    if (projected[0].type === "activity") expect(activityLabel(projected[0])).toBe("Read 2 files");
  });

  it("keeps activity groups separated by assistant prose", () => {
    const answer: MessageBlock = { ...thought, id: "answer", role: "assistant", text: "Done" };
    expect(projectTranscript([tool("read", "Read file"), answer, tool("test", "Run tests")]).map((block) => block.type))
      .toEqual(["activity", "message", "activity"]);
  });

  it("marks a mixed group failed when any tool fails", () => {
    const projected = projectTranscript([tool("read", "Read file"), tool("test", "Run tests", "failed")]);
    expect(projected[0]).toMatchObject({ type: "activity", status: "failed" });
    if (projected[0].type === "activity") expect(activityLabel(projected[0])).toBe("2 tool calls");
  });
});
