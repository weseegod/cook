/**
 * Pure helpers for the `x.ai/mcp/elicit` card: an MCP server asks the user for input, described
 * by a JSON-Schema subset (`requestedSchema`). The card renders one control per property and
 * sends the collected values back as `content`.
 */

export interface ElicitField {
  name: string;
  label: string;
  description?: string;
  type: "string" | "number" | "boolean" | "enum" | "other";
  required: boolean;
  /** Choices for `enum`, plus `oneOf`/`anyOf` `{const,title}` entries. */
  options?: Array<{ value: string; label: string }>;
  default?: string;
}

export type ElicitValues = Record<string, string>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionLabel(entry: unknown, fallback: string): { value: string; label: string } {
  if (typeof entry === "string") return { value: entry, label: entry };
  if (typeof entry === "number" || typeof entry === "boolean") {
    return { value: String(entry), label: String(entry) };
  }
  const record = asRecord(entry);
  if (!record) return { value: fallback, label: fallback };
  const value = record.const ?? record.value ?? record.enum;
  const label = record.title ?? record.label ?? value;
  return { value: String(value ?? fallback), label: String(label ?? fallback) };
}

/** The controls an elicitation form renders, in schema declaration order. */
export function elicitFields(schema: unknown): ElicitField[] {
  const root = asRecord(schema);
  const properties = asRecord(root?.properties);
  if (!properties) return [];
  const required = new Set(
    Array.isArray(root?.required) ? root!.required.filter((name): name is string => typeof name === "string") : [],
  );
  const fields: ElicitField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw) ?? {};
    const choices = Array.isArray(property.enum)
      ? property.enum
      : Array.isArray(property.oneOf)
        ? property.oneOf
        : Array.isArray(property.anyOf)
          ? property.anyOf
          : null;
    const declared = typeof property.type === "string" ? property.type : undefined;
    let type: ElicitField["type"] = "other";
    if (choices) type = "enum";
    else if (declared === "string") type = "string";
    else if (declared === "number" || declared === "integer") type = "number";
    else if (declared === "boolean") type = "boolean";
    fields.push({
      name,
      label: typeof property.title === "string" && property.title ? property.title : name,
      ...(typeof property.description === "string" && property.description
        ? { description: property.description }
        : {}),
      type,
      required: required.has(name),
      ...(choices ? { options: choices.map((entry, index) => optionLabel(entry, `${name}-${index}`)) } : {}),
      ...(property.default !== undefined && property.default !== null
        ? { default: String(property.default) }
        : {}),
    });
  }
  return fields;
}

/** `true` when every required field carries a non-blank value. */
export function elicitFormComplete(fields: ElicitField[], values: ElicitValues): boolean {
  return fields.every((field) => !field.required || (values[field.name] ?? "").trim() !== "");
}

/**
 * Coerce the collected strings to the types the schema declared. Blank optional fields are
 * omitted so the server sees "not provided" rather than an empty string.
 */
export function elicitContent(fields: ElicitField[], values: ElicitValues): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (raw === "") {
      if (field.required) content[field.name] = field.type === "number" ? 0 : field.type === "boolean" ? false : "";
      continue;
    }
    if (field.type === "number") {
      const parsed = Number(raw);
      content[field.name] = Number.isFinite(parsed) ? parsed : raw;
    } else if (field.type === "boolean") {
      content[field.name] = raw === "true";
    } else {
      content[field.name] = raw;
    }
  }
  return content;
}
