import { describe, expect, it } from "vitest";
import { elicitContent, elicitFields, elicitFormComplete } from "./elicit-fields";

/** The shape `x.ai/mcp/elicit` carries for `mode: "form"`. */
const schema = {
  type: "object",
  properties: {
    path: { type: "string", title: "Directory", description: "Absolute path to expose" },
    depth: { type: "integer" },
    mode: { type: "string", enum: ["read", "readwrite"] },
    confirm: { type: "boolean" },
  },
  required: ["path", "mode"],
};

describe("elicitation form fields", () => {
  it("turns a requested schema into labelled controls", () => {
    const fields = elicitFields(schema);
    expect(fields.map((field) => field.name)).toEqual(["path", "depth", "mode", "confirm"]);
    expect(fields[0]).toMatchObject({ label: "Directory", type: "string", required: true });
    expect(fields[0].description).toBe("Absolute path to expose");
    expect(fields[1]).toMatchObject({ label: "depth", type: "number", required: false });
    expect(fields[2]).toMatchObject({ type: "enum", required: true });
    expect(fields[2].options).toEqual([
      { value: "read", label: "read" },
      { value: "readwrite", label: "readwrite" },
    ]);
    expect(fields[3].type).toBe("boolean");
  });

  it("reads `oneOf`/`anyOf` choices and defaults, and tolerates a missing schema", () => {
    const fields = elicitFields({
      type: "object",
      properties: {
        choice: { oneOf: [{ const: "a", title: "Option A" }, { const: "b" }] },
        note: { type: "string", default: "hello" },
      },
    });
    expect(fields[0].options).toEqual([
      { value: "a", label: "Option A" },
      { value: "b", label: "b" },
    ]);
    expect(fields[1].default).toBe("hello");
    expect(elicitFields(undefined)).toEqual([]);
    expect(elicitFields({ type: "object" })).toEqual([]);
  });

  it("blocks accept until every required field is filled", () => {
    const fields = elicitFields(schema);
    expect(elicitFormComplete(fields, {})).toBe(false);
    expect(elicitFormComplete(fields, { path: "/tmp" })).toBe(false);
    expect(elicitFormComplete(fields, { path: "  ", mode: "read" })).toBe(false);
    expect(elicitFormComplete(fields, { path: "/tmp", mode: "read" })).toBe(true);
  });

  it("coerces values to the declared types and omits blank optionals", () => {
    const fields = elicitFields(schema);
    expect(elicitContent(fields, { path: "/tmp", depth: "3", mode: "read", confirm: "true" })).toEqual({
      path: "/tmp",
      depth: 3,
      mode: "read",
      confirm: true,
    });
    expect(elicitContent(fields, { path: "/tmp", mode: "read", depth: "", confirm: "" })).toEqual({
      path: "/tmp",
      mode: "read",
    });
  });

  it("keeps a required blank field present so the server sees the empty answer", () => {
    const fields = elicitFields(schema);
    expect(elicitContent(fields, { mode: "read" })).toEqual({ path: "", mode: "read" });
  });

  it("passes a non-numeric string through rather than inventing a number", () => {
    const fields = elicitFields({ type: "object", properties: { depth: { type: "integer" } } });
    expect(elicitContent(fields, { depth: "many" })).toEqual({ depth: "many" });
  });
});
