import type { JsonSchema } from "../llm/types.ts";

// A deliberately small JSON Schema checker: enough to catch the mistakes models actually make
// (missing fields, wrong types, values outside an enum) without pulling in a dependency.
// Supports: type (object, array, string, number, integer, boolean), properties, required,
// items, enum, minItems, minimum, maximum.

type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  const expected = schema.type as string | undefined;
  if (expected && !matchesType(expected, value)) {
    errors.push(`${path || "value"} should be ${expected} but was ${typeOf(value)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path || "value"} should be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path || "value"} should be at least ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path || "value"} should be at most ${schema.maximum}`);
    }
  }

  if (expected === "object" && value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${path ? path + "." : ""}${key} is required`);
    }
    const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in obj) check(propSchema, obj[key], path ? `${path}.${key}` : key, errors);
    }
  }

  if (expected === "array" && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path || "value"} should have at least ${schema.minItems} items`);
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, i) => check(schema.items as Schema, item, `${path}[${i}]`, errors));
    }
  }
}

/** Returns a list of human-readable problems; an empty list means the value is valid. */
export function validate(schema: JsonSchema, value: unknown): string[] {
  const errors: string[] = [];
  check(schema, value, "", errors);
  return errors;
}
