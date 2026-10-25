import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { runAgent } from "../../src/agent/runAgent.ts";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible.ts";

// Gemini 3, through its OpenAI-compatible endpoint, attaches a "thought signature" to tool calls
// and rejects the next request with 400 if the signature does not come back unchanged.
// This fake server behaves the same way.

const SIGNATURE = { google: { thought_signature: "CvcQAdHN2OekY10ClPFkYA==" } };

test("tool call signatures from the provider are sent back unchanged", async () => {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader("content-type", "application/json");

    if (requests.length === 1) {
      res.end(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "list_rooms", arguments: "{}" }, extra_content: SIGNATURE }],
          },
        }],
      }));
      return;
    }

    const assistant = request.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
    if (JSON.stringify(assistant?.tool_calls?.[0]?.extra_content) !== JSON.stringify(SIGNATURE)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { code: 400, message: "Function call is missing a thought_signature" } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Two rooms." } }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  try {
    const model = createOpenAICompatibleClient({ model: "gemini-test", baseUrl: `http://127.0.0.1:${port}`, provider: "openai-compatible" });
    const result = await runAgent({
      model,
      system: "You are a QA agent.",
      task: "How many rooms are there?",
      tools: [{
        name: "list_rooms",
        description: "List the rooms.",
        inputSchema: { type: "object", properties: {} },
        run: async () => "r1, r2",
      }],
    });
    expect(result.status).toBe("done");
    expect(result.text).toBe("Two rooms.");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.find((m: any) => m.role === "assistant").tool_calls[0].extra_content).toEqual(SIGNATURE);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

