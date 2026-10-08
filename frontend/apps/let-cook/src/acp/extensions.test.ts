import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./host", () => ({
  notify: vi.fn(async () => undefined),
  request: vi.fn(async () => ({})),
  respond: vi.fn(async () => undefined),
}));

import { request } from "./host";
import { readSkillDefault, restoreSkillDefault } from "./extensions";

describe("skill default requests", () => {
  beforeEach(() => {
    vi.mocked(request).mockResolvedValue({});
  });

  it("reads one skill's shipped default against the workspace", async () => {
    await readSkillDefault("review", "/work/app");
    expect(request).toHaveBeenCalledWith("x.ai/skills/default", {
      name: "review",
      cwd: "/work/app",
    });
  });

  it("falls back to '.' so discovery never loses its cwd", async () => {
    await readSkillDefault("review");
    expect(request).toHaveBeenCalledWith("x.ai/skills/default", { name: "review", cwd: "." });
  });

  it("restores one skill by name", async () => {
    await restoreSkillDefault("review", "/work/app");
    expect(request).toHaveBeenCalledWith("x.ai/skills/restore", {
      name: "review",
      cwd: "/work/app",
    });
  });
});
