import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { fetchWithRetry } from "../../src/llm/http.ts";
import { createOpenAICompatibleClient } from "../../src/llm/openai-compatible.ts";

// A tiny local server that answers with a scripted sequence of statuses.
async function scriptedServer(statuses: number[]): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server: Server = createServer((_req, res) => {
    const status = statuses[Math.min(hits, statuses.length - 1)];
    hits++;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      status === 200
        ? JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] })
        : JSON.stringify({ error: { code: status, message: "scripted" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const noWait = { sleep: async () => {}, onRetry: () => {} };

test("a busy provider (503) is retried until it answers", async () => {
  const server = await scriptedServer([503, 503, 200]);
  try {
    const res = await fetchWithRetry(server.url, { method: "POST" }, { retries: 4, ...noWait });
    expect(res.status).toBe(200);
    expect(server.hits()).toBe(3);
  } finally {
    await server.close();
  }
});

test("a permanent error (401) is not retried", async () => {
  const server = await scriptedServer([401]);
  try {
    const res = await fetchWithRetry(server.url, { method: "POST" }, { retries: 4, ...noWait });
    expect(res.status).toBe(401);
    expect(server.hits()).toBe(1);
  } finally {
    await server.close();
  }
});

test("retries stop at the limit and the last error reaches the caller", async () => {
  const server = await scriptedServer([503]);
  const waits: number[] = [];
  try {
    const res = await fetchWithRetry(server.url, { method: "POST" }, {
      retries: 2,
      baseDelayMs: 100,
      sleep: async (ms) => void waits.push(ms),
      onRetry: () => {},
    });
    expect(res.status).toBe(503);
    expect(server.hits()).toBe(3);
    expect(waits).toEqual([100, 200]);
  } finally {
    await server.close();
  }
});

test("the model client recovers from a 503 on its own", async () => {
  const server = await scriptedServer([503, 200]);
  process.env.QA_MODEL_MAX_RETRIES = "2";
  // This one waits for real: one 2 s backoff, exactly what a user would see.
  try {
    const client = createOpenAICompatibleClient({ model: "test", baseUrl: server.url, provider: "openai-compatible" });
    const response = await client.complete({ system: "", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(response.text).toBe("ok");
    expect(server.hits()).toBe(2);
  } finally {
    delete process.env.QA_MODEL_MAX_RETRIES;
    await server.close();
  }
});
