import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "@playwright/test";

// The qa-crew MCP server, as an IDE would use it: over stdio, with a person who answers
// (or does not answer) the questions the server asks. The stages are fakes.

type Answer = { action: "accept"; content: Record<string, string | number | boolean | string[]> } | { action: "decline" } | { action: "cancel" };

let dir: string;
let asked: string[];
let nextAnswer: Answer | undefined;

async function connect(canAsk = true): Promise<Client> {
  const client = new Client({ name: "test-ide", version: "1.0.0" }, { capabilities: canAsk ? { elicitation: { form: {} } } : {} });
  if (canAsk) {
    client.setRequestHandler("elicitation/create", async (request) => {
      asked.push(String(request.params.message));
      return nextAnswer ?? { action: "cancel" };
    });
  }
  await client.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "tests/tools/fixtures/crew-server-fake.ts"],
      env: { ...process.env, QA_CREW_RUNS: path.join(dir, "runs"), QA_CREW_ISSUES: path.join(dir, "issues") } as Record<string, string>,
      stderr: "ignore",
    }),
  );
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { text: (result.content as { text: string }[]).map((c) => c.text).join("\n"), isError: !!result.isError };
};

test.beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "crew-mcp-"));
  asked = [];
  nextAnswer = undefined;
});
test.afterEach(async () => rm(dir, { recursive: true, force: true }));

test("exposes read-only status and review, and decision tools that ask a person", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["crew_approve", "crew_continue", "crew_file_bug", "crew_review", "crew_start", "crew_status"]);
    expect(byName.crew_status.annotations?.readOnlyHint).toBe(true);
    expect(byName.crew_review.annotations?.readOnlyHint).toBe(true);
    expect(byName.crew_approve.annotations?.readOnlyHint).toBe(false);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["crew-inbox", "review-gate"]);
  } finally {
    await client.close();
  }
});

test("a run started from the IDE stops at the gate; the person approves in the IDE, and the approval is recorded", async () => {
  const client = await connect();
  try {
    expect((await call(client, "crew_start", { feature: "booking-rules", auto: true })).text).toContain("Refused");

    const started = await call(client, "crew_start", { feature: "booking-rules" });
    expect(started.text).toContain("waiting for approval of the risk map");
    expect((await call(client, "crew_review")).text).toContain("R1 capacity");

    // The person declines: nothing changes.
    nextAnswer = { action: "decline" };
    expect((await call(client, "crew_approve")).text).toContain("Not approved");
    expect((await call(client, "crew_status")).text).toContain("waiting for approval of the risk map");

    // The person approves, with a note.
    nextAnswer = { action: "accept", content: { approve: true, note: "R6 is out of scope" } };
    const approved = await call(client, "crew_approve");
    expect(asked.at(-1)).toContain("Approve the risk map");
    expect(approved.text).toContain("waiting for approval of the test plan");

    const runs = await readdir(path.join(dir, "runs"));
    const run = JSON.parse(await readFile(path.join(dir, "runs", runs[0], "run.json"), "utf8"));
    expect(run.approvals[0]).toMatchObject({ gate: "analyze", mode: "human", by: "enrique (via MCP, test-ide)", note: "R6 is out of scope" });
    expect(run.approvals[0].sha256).toMatch(/^[0-9a-f]{64}$/);

    // The resource template serves the run's files.
    const resource = await client.readResource({ uri: `crew://runs/${runs[0]}/risk-map.md` });
    expect((resource.contents[0] as { text: string }).text).toContain("R1 capacity");
  } finally {
    await client.close();
  }
});

test("a host that cannot ask the person cannot approve", async () => {
  const ide = await connect();
  try {
    await call(ide, "crew_start");
  } finally {
    await ide.close();
  }
  const headless = await connect(false);
  try {
    const result = await call(headless, "crew_approve");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("an assistant's own judgment is not an approval");
    const runs = await readdir(path.join(dir, "runs"));
    const run = JSON.parse(await readFile(path.join(dir, "runs", runs[0], "run.json"), "utf8"));
    expect(run.approvals).toEqual([]);
  } finally {
    await headless.close();
  }
});

test("a confirmed draft is filed as the next issue; duplicates and repeats are refused", async () => {
  const client = await connect();
  try {
    await call(client, "crew_start");
    nextAnswer = { action: "accept", content: { approve: true } };
    await call(client, "crew_approve");
    const done = await call(client, "crew_approve");
    expect((await call(client, "crew_status")).text).toContain(": done.");
    expect(done.text).toMatch(/done/);

    expect((await call(client, "crew_file_bug", { caseId: "TC-02" })).text).toContain("already reported as ISSUE-0031");

    nextAnswer = { action: "accept", content: { file: true } };
    const filed = await call(client, "crew_file_bug", { caseId: "TC-05" });
    expect(asked.at(-1)).toContain('File "Bookings can be made for stays that have already started"');
    expect(filed.text).toContain("Filed as ISSUE-0001");
    const issue = await readFile(path.join(dir, "issues", (await readdir(path.join(dir, "issues")))[0]), "utf8");
    expect(issue).toContain("# ISSUE-0001: Bookings can be made for stays that have already started");
    expect(issue).toContain("- **Status:** open");
    expect(issue).toContain("by enrique (via MCP, test-ide)");

    expect((await call(client, "crew_file_bug", { caseId: "TC-05" })).text).toContain("already filed as ISSUE-0001");
  } finally {
    await client.close();
  }
});
