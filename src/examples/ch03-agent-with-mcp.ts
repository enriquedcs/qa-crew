// Chapter 3: the Chapter 2 agent, with its tools coming from MCP servers.
//
// The system prompt, the task, the output schema and runAgent() are unchanged.
// Only the tools moved: from hand-written functions to the qa-tools MCP server,
// which Claude Code, Cursor, Copilot or Codex can use too.
//
//   npm run app                          # in one terminal
//   npm run ch03                         # in another (uses QA_MODEL_* from .env)
//   QA_MODEL_PROVIDER=mock npm run ch03  # no API key: a scripted model, real MCP tools
//   QA_WITH_BROWSER=true npm run ch03    # also give the agent a browser through Playwright MCP

import { runAgent } from "../agent/runAgent.ts";
import { createMockClient, createModelFromEnv, type JsonSchema, type ModelClient } from "../llm/index.ts";
import { connectMcpServers, loadMcpConfig, type McpConnection } from "../mcp/connect.ts";

try {
  process.loadEnvFile?.();
} catch {
  // No .env file: fall back to the shell environment.
}

const servers = await loadMcpConfig(".mcp.json");

const connections: McpConnection[] = [
  // Belt and braces: even if writes were enabled on the server, this agent only gets read-only tools.
  { name: "qa-tools", config: servers["qa-tools"], filter: { readOnly: true } },
];

if (process.env.QA_WITH_BROWSER === "true") {
  connections.push({
    name: "playwright",
    config: servers.playwright,
    // Playwright MCP has dozens of tools. Give the agent only the ones this task needs.
    filter: { include: ["browser_navigate", "browser_snapshot", "browser_close"] },
  });
}

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
    { text: "First I'll look at the API and the rooms.", toolCalls: [{ name: "get_api_reference", input: {} }, { name: "list_rooms", input: {} }] },
    { text: "Which tests exist already?", toolCalls: [{ name: "list_test_files", input: {} }] },
    { toolCalls: [{ name: "read_test_file", input: { path: "baseline/api.spec.ts" } }, { name: "read_test_file", input: { path: "baseline/ui.spec.ts" } }] },
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
const toolbox = await connectMcpServers(connections);

try {
  console.log(`Using ${model.provider} / ${model.model}`);
  console.log(`MCP tools: ${toolbox.tools.map((t) => t.name).join(", ")}\n`);

  const result = await runAgent<TestIdeas>({
    model,
    system,
    task,
    tools: toolbox.tools,
    output: { schema: outputSchema },
    maxSteps: 10,
    onEvent: (e) => {
      if (e.type === "model") {
        if (e.text) console.log(`[step ${e.step}] ${e.text}`);
        for (const call of e.toolCalls) console.log(`[step ${e.step}] -> ${call.name}(${JSON.stringify(call.input)})`);
      } else if (e.type === "tool") {
        console.log(`[step ${e.step}] <- ${e.name}${e.isError ? " (error)" : ""}: ${e.result.length} chars`);
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
} finally {
  // Always close: each connection owns a child process.
  await toolbox.close();
}
