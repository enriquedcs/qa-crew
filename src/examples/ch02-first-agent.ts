// Chapter 2: your first QA agent.
//
// The agent explores the booking API, reads the baseline tests, and proposes
// test ideas the suite is missing, returned as structured data.
//
//   npm run app                 # in one terminal
//   npm run ch02                # in another (uses QA_MODEL_* from .env)
//   QA_MODEL_PROVIDER=mock npm run ch02   # no API key needed: a scripted demo of the loop

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runAgent, type Tool } from "../agent/runAgent.ts";
import { createMockClient, createModelFromEnv, type JsonSchema, type ModelClient } from "../llm/index.ts";

try {
  process.loadEnvFile?.();
} catch {
  // No .env file: fall back to the shell environment.
}

const BOOKING_URL = process.env.BOOKING_URL ?? "http://localhost:3000";
const BASELINE_DIR = path.resolve("tests/baseline");

const tools: Tool[] = [
  {
    name: "get_rooms",
    description: "List the rooms in the booking app, with capacity and price per night.",
    inputSchema: { type: "object", properties: {} },
    run: async () => (await fetch(`${BOOKING_URL}/api/rooms`)).json(),
  },
  {
    name: "get_api_reference",
    description: "Get the booking API's endpoints and the fields a booking needs.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const readme = await readFile("README.md", "utf8");
      const start = readme.indexOf("## Booking API");
      const end = readme.indexOf("\n## ", start + 1);
      return readme.slice(start, end === -1 ? undefined : end);
    },
  },
  {
    name: "read_baseline_tests",
    description: "Read the existing hand-written Playwright tests, so you know what is already covered.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const files = (await readdir(BASELINE_DIR)).filter((f) => f.endsWith(".ts"));
      const contents = await Promise.all(
        files.map(async (f) => `// ${f}\n${await readFile(path.join(BASELINE_DIR, f), "utf8")}`),
      );
      return contents.join("\n\n");
    },
  },
];

interface TestIdeas {
  summary: string;
  ideas: { title: string; risk: "high" | "medium" | "low"; why: string; layer: "api" | "ui" }[];
}

const outputSchema: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One or two sentences on what the current suite covers." },
    ideas: {
      type: "array",
      minItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          risk: { type: "string", enum: ["high", "medium", "low"] },
          why: { type: "string", description: "Why this matters and why the current tests miss it." },
          layer: { type: "string", enum: ["api", "ui"] },
        },
        required: ["title", "risk", "why", "layer"],
      },
    },
  },
  required: ["summary", "ideas"],
};

const system = `You are a senior QA engineer reviewing a booking application.
Work like a tester, not a chatbot:
- Use your tools to gather facts before you conclude anything.
- Prefer business rules and risks over trivial input checks.
- Only propose ideas the existing tests do not already cover.
When you are done, submit your result with the submit_result tool.`;

const task = "Find the most valuable tests missing from the baseline suite for the booking app.";

function scriptedDemo(): ModelClient {
  return createMockClient([
    { text: "First I'll look at the API and the rooms.", toolCalls: [{ name: "get_api_reference", input: {} }, { name: "get_rooms", input: {} }] },
    { text: "Now let me see what the baseline suite already covers.", toolCalls: [{ name: "read_baseline_tests", input: {} }] },
    {
      toolCalls: [
        {
          name: "submit_result",
          input: {
            summary: "The baseline covers happy paths, one missing-name check, one overlap check and cancellation.",
            ideas: [
              { title: "Reject guests above room capacity via the API", risk: "high", why: "Rooms have a capacity, but no test sends more guests than allowed.", layer: "api" },
              { title: "Reject check-in dates in the past", risk: "high", why: "No test covers dates before today.", layer: "api" },
              { title: "Allow back-to-back stays on the same room", risk: "medium", why: "The overlap test does not check that a checkout day can be the next check-in.", layer: "api" },
            ],
          },
        },
      ],
    },
  ]);
}

const model = (process.env.QA_MODEL_PROVIDER ?? "").toLowerCase() === "mock" ? scriptedDemo() : createModelFromEnv();
console.log(`Using ${model.provider} / ${model.model}\n`);

const result = await runAgent<TestIdeas>({
  model,
  system,
  task,
  tools,
  output: { schema: outputSchema },
  maxSteps: 8,
  onEvent: (e) => {
    if (e.type === "model") {
      if (e.text) console.log(`[step ${e.step}] ${e.text}`);
      for (const call of e.toolCalls) console.log(`[step ${e.step}] -> ${call.name}(${JSON.stringify(call.input)})`);
    } else if (e.type === "tool") {
      console.log(`[step ${e.step}] <- ${e.name}${e.isError ? " (error)" : ""}: ${e.result.length} chars`);
    } else if (e.type === "truncated") {
      console.log(`[step ${e.step}] response cut off at the ${e.maxTokens}-token output limit`);
    } else {
      console.log(`[step ${e.step}] invalid result: ${e.errors.join("; ")}`);
    }
  },
});

console.log(`\nStatus: ${result.status} after ${result.steps} steps (${result.usage.inputTokens} in / ${result.usage.outputTokens} out tokens)\n`);
if (result.output) {
  console.log(result.output.summary + "\n");
  for (const idea of result.output.ideas) {
    console.log(`- [${idea.risk.toUpperCase()}] (${idea.layer}) ${idea.title}\n    ${idea.why}`);
  }
}
