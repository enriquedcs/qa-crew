import type { Tool } from "../../agent/runAgent.ts";

// Test data helpers. Models are bad at arithmetic and calendars, and fixed dates
// in tests rot: "2030-05-01" is in the future today and in the past one day.
// So the Designer asks code for exact values instead of inventing them.

/** The first value inside each limit and the first value outside it. */
export function boundaryValues(min: number, max: number, step = 1): { value: number; valid: boolean }[] {
  const values = [min - step, min, max, max + step];
  return [...new Set(values)].map((value) => ({ value, valid: value >= min && value <= max }));
}

/** An ISO date relative to a base date (UTC), for example daysFromToday(1) is tomorrow. */
export function daysFrom(base: Date, days: number): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + days));
  return d.toISOString().slice(0, 10);
}

// Invented, clearly fake names: never copy real customer data into tests.
const SAFE_NAMES = ["Ana Prueba", "Luis Ejemplo", "Mei Testcase", "Omar Fixture", "Zoe Sample"];

export function safeGuestName(index = 0): string {
  return SAFE_NAMES[index % SAFE_NAMES.length];
}

/** Local tools for the Designer. They need no server, so they are plain Tool objects, not MCP. */
export function testDataTools(today: () => Date = () => new Date()): Tool[] {
  return [
    {
      name: "boundary_values",
      description:
        "Get the boundary values for a numeric rule with a minimum and a maximum, with whether each is valid. " +
        "For example capacity 2 with at least 1 guest: min 1, max 2.",
      inputSchema: {
        type: "object",
        properties: { min: { type: "number" }, max: { type: "number" } },
        required: ["min", "max"],
      },
      run: async (input) => boundaryValues(Number(input.min), Number(input.max)),
    },
    {
      name: "relative_dates",
      description:
        "Turn day offsets from today into YYYY-MM-DD dates, for example [-1, 0, 1, 15] for yesterday, today, " +
        "tomorrow and 15 days ahead. Tests should describe dates as offsets so they never go stale.",
      inputSchema: {
        type: "object",
        properties: { offsets: { type: "array", items: { type: "integer" } } },
        required: ["offsets"],
      },
      run: async (input) => {
        const base = today();
        return (input.offsets as number[]).map((offset) => ({ offset, date: daysFrom(base, offset) }));
      },
    },
    {
      name: "safe_guest_names",
      description: "Get invented guest names that are safe to use in tests (never use real customer data).",
      inputSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
      run: async (input) => Array.from({ length: Number(input.count) }, (_, i) => safeGuestName(i)),
    },
  ];
}
