import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural invariants for the shipped renderer.
 *
 * The window is a view: the agent owns `config.toml`, credentials, and every model/tool request.
 * These checks fail the build if a future change starts doing any of that in the renderer.
 */

const SRC = join(process.cwd(), "src");

function sources(directory: string = SRC): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.tsx?$/.test(entry)) return [];
    if (entry.endsWith(".test.ts") || entry.endsWith(".test.tsx")) return [];
    return [path];
  });
}

const FILES = sources().map((path) => ({ path, rel: relative(SRC, path), text: readFileSync(path, "utf8") }));

const RULES: Array<{ name: string; pattern: RegExp; allow?: string[] }> = [
  {
    name: "no HTTP client of any kind (the agent makes every model/tool call)",
    pattern: /\b(fetch|XMLHttpRequest|WebSocket|axios)\s*\(|\baxios\b/,
  },
  {
    name: "no TOML parser or emitter (a second config writer would race the agent)",
    pattern: /toml_edit|smol-toml|@iarna\/toml|\btoml\.(stringify|parse)|parseToml|stringifyToml/i,
  },
  {
    name: "no filesystem writes outside the agent's fs extension",
    pattern: /\bwriteFileSync\s*\(|\bwriteFile\s*\(|\bmkdirSync\s*\(|\bunlinkSync\s*\(/,
  },
  {
    name: "IPC only through the single host bridge",
    pattern: /\binvoke\s*\(|\blisten\s*\(/,
    allow: ["acp/host.ts"],
  },
  {
    name: "the agent process is only started from the host bridge",
    pattern: /child_process|Command::new|spawn\s*\(/,
    allow: [],
  },
];

describe("renderer invariants", () => {
  it("has sources to check", () => {
    expect(FILES.length).toBeGreaterThan(15);
  });

  for (const rule of RULES) {
    it(rule.name, () => {
      const offenders = FILES.filter(
        (file) => !rule.allow?.includes(file.rel) && rule.pattern.test(file.text),
      ).map((file) => file.rel);
      expect(offenders, `${rule.name}: ${offenders.join(", ")}`).toEqual([]);
    });
  }

  it("keeps every config.toml write behind an ACP request", () => {
    const providerApi = FILES.find((file) => file.rel === "acp/providers.ts");
    expect(providerApi, "acp/providers.ts exists").toBeTruthy();
    // Every exported call in the provider API is an ACP request, never a local write.
    const exported = [...providerApi!.text.matchAll(/export (?:async )?function (\w+)/g)].map((match) => match[1]);
    expect(exported).toContain("upsertProvider");
    expect(exported).toContain("deleteProvider");
    expect(exported).toContain("setDefaultModel");
    for (const name of ["upsertProvider", "deleteProvider", "testProvider", "discoverProviderModels", "setDefaultModel"]) {
      const start = providerApi!.text.indexOf(`function ${name}`);
      expect(start, `${name} is declared`).toBeGreaterThanOrEqual(0);
      const body = providerApi!.text.slice(start, start + 400);
      expect(body, `${name} must go through host.request`).toMatch(/request[<(]/);
    }
  });
});
