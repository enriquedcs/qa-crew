import { test, expect } from "@playwright/test";
import { runAgent } from "../../src/agent/runAgent.ts";
import { createMockClient } from "../../src/llm/index.ts";
import { connectMcpServers, contentToText, expandEnv, loadMcpConfig } from "../../src/mcp/connect.ts";

// The bridge between MCP and the agent loop. The end-to-end test uses a
// scripted model and the real qa-tools server, so it needs no API key.

const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;

test("an agent calls MCP tools through the unchanged agent loop", async () => {
  const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
  const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"] }]);
  try {
    const model = createMockClient([
      { toolCalls: [{ name: "list_rooms", input: {} }] },
      { text: "There are three rooms." },
    ]);

    const result = await runAgent({ model, system: "s", task: "How many rooms are there?", tools: toolbox.tools });

    expect(result.status).toBe("done");
    // The model was offered the MCP tools, with the schemas the server advertised...
    expect(model.requests[0].tools.map((t) => t.name)).toContain("read_test_file");
    // ...and the second request carries the live result of the MCP call.
    const toolMessage = model.requests[1].messages.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ role: "tool", name: "list_rooms" });
    expect(toolMessage && "content" in toolMessage ? toolMessage.content : "").toContain("Family Suite");
  } finally {
    await toolbox.close();
  }
});

test("an MCP error result reaches the model as a tool error", async () => {
  const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
  const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"] }]);
  try {
    const model = createMockClient([
      { toolCalls: [{ name: "read_test_file", input: { path: "../package.json" } }] },
      { text: "That file is out of reach." },
    ]);
    const result = await runAgent({ model, system: "s", task: "t", tools: toolbox.tools });
    const toolMessage = result.transcript.find((m) => m.role === "tool");
    expect(toolMessage).toMatchObject({ isError: true });
  } finally {
    await toolbox.close();
  }
});

test("expandEnv supports ${VAR} and ${VAR:-default}", () => {
  expect(expandEnv("${HOST}:${PORT:-3000}", { HOST: "localhost" })).toBe("localhost:3000");
  expect(expandEnv("${PORT:-3000}", { PORT: "3100" })).toBe("3100");
  expect(() => expandEnv("${MISSING}", {})).toThrow(/MISSING is not set/);
});

test("contentToText keeps text and summarizes other content", () => {
  expect(
    contentToText([
      { type: "text", text: "Snapshot:" },
      { type: "image", mimeType: "image/png" },
      { type: "resource", resource: { uri: "x://1", text: "embedded" } },
    ]),
  ).toBe("Snapshot:\n[image image/png omitted]\nembedded");
});
