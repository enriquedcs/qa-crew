import { test, expect } from "@playwright/test";
import { runAgent, SUBMIT_TOOL, type Tool } from "../../src/agent/runAgent.ts";
import { createMockClient } from "../../src/llm/index.ts";

// Agents are code too, so they get tests. These run without any API key:
// a scripted mock model plays the role of the LLM.

const echo: Tool = {
  name: "echo",
  description: "Echo the input back.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: async (input) => `echo: ${input.text}`,
};

const schema = {
  type: "object" as const,
  properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
  required: ["verdict"],
};

test("returns plain text when no output schema is required", async () => {
  const model = createMockClient([{ text: "All good." }]);
  const result = await runAgent({ model, system: "s", task: "t" });
  expect(result.status).toBe("done");
  expect(result.text).toBe("All good.");
  expect(result.steps).toBe(1);
});

test("runs a tool and feeds the result back to the model", async () => {
  const model = createMockClient([
    { toolCalls: [{ name: "echo", input: { text: "hi" } }] },
    { text: "Done." },
  ]);
  const result = await runAgent({ model, system: "s", task: "t", tools: [echo] });
  expect(result.status).toBe("done");
  const second = model.requests[1].messages.at(-1);
  expect(second).toMatchObject({ role: "tool", name: "echo", content: "echo: hi" });
});

test("reports tool errors to the model instead of crashing", async () => {
  const broken: Tool = { ...echo, name: "broken", run: async () => { throw new Error("boom"); } };
  const model = createMockClient([
    { toolCalls: [{ name: "broken", input: {} }] },
    { text: "Recovered." },
  ]);
  const result = await runAgent({ model, system: "s", task: "t", tools: [broken] });
  expect(result.status).toBe("done");
  expect(model.requests[1].messages.at(-1)).toMatchObject({ role: "tool", isError: true, content: "boom" });
});

test("rejects an invalid result and accepts the corrected one", async () => {
  const model = createMockClient([
    { toolCalls: [{ name: SUBMIT_TOOL, input: { verdict: "maybe" } }] },
    { toolCalls: [{ name: SUBMIT_TOOL, input: { verdict: "pass" } }] },
  ]);
  const result = await runAgent<{ verdict: string }>({ model, system: "s", task: "t", output: { schema } });
  expect(result.status).toBe("done");
  expect(result.output).toEqual({ verdict: "pass" });
  expect(result.steps).toBe(2);
});

test("stops at maxSteps when the model never finishes", async () => {
  const loop = { toolCalls: [{ name: "echo", input: { text: "again" } }] };
  const model = createMockClient([loop, loop, loop, loop]);
  const result = await runAgent({ model, system: "s", task: "t", tools: [echo], maxSteps: 3 });
  expect(result.status).toBe("max_steps");
  expect(model.requests).toHaveLength(3);
});

test("on the last step, an agent that owes a result can only submit it", async () => {
  const model = createMockClient([
    { toolCalls: [{ name: "echo", input: { text: "1" } }] },
    { toolCalls: [{ name: "echo", input: { text: "2" } }] },
    { toolCalls: [{ name: SUBMIT_TOOL, input: { verdict: "pass" } }] },
  ]);
  const result = await runAgent<{ verdict: string }>({ model, system: "s", task: "t", tools: [echo], output: { schema }, maxSteps: 3 });

  expect(result.status).toBe("done");
  expect(model.requests[1].tools.map((t) => t.name)).toEqual(["echo", SUBMIT_TOOL]);
  expect(model.requests[2].tools.map((t) => t.name)).toEqual([SUBMIT_TOOL]);
  expect(model.requests[2].system).toContain("This is your last step");
});

test("a response cut off at the output limit is not run; the model is told to be more concise", async () => {
  const model = createMockClient([
    { toolCalls: [{ name: SUBMIT_TOOL, input: {} }], truncated: true },
    { toolCalls: [{ name: SUBMIT_TOOL, input: { verdict: "pass" } }] },
  ]);
  const events: string[] = [];
  const result = await runAgent<{ verdict: string }>({
    model, system: "s", task: "t", output: { schema }, maxTokens: 1000, onEvent: (e) => events.push(e.type),
  });

  expect(result.output).toEqual({ verdict: "pass" });
  expect(events).toContain("truncated");
  expect(events).not.toContain("invalid_output");
  expect(model.requests[0].maxTokens).toBe(1000);
  const notice = model.requests[1].messages.find((m) => m.role === "tool");
  expect(notice && "content" in notice ? notice.content : "").toContain("output limit of 1000 tokens");
});
