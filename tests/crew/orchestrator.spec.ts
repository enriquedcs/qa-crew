import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  advance,
  approve,
  changedSinceApproval,
  createRun,
  latestRunId,
  loadRun,
  type RunStore,
  type Stage,
} from "../../src/crew/orchestrator.ts";
import { crewStages } from "../../src/crew/stages.ts";
import { decisionsFor, renderRunSummary } from "../../src/crew/summary.ts";

// Fake stages: the orchestrator does not care what a stage does, only what it reports.
function fakeStages(calls: string[], options: { failAt?: string; tokens?: number } = {}): Stage[] {
  const make = (name: string, review?: string): Stage => ({
    name,
    title: name,
    async run(ctx) {
      calls.push(name);
      if (options.failAt === name) throw new Error(`${name} broke`);
      if (review) await ctx.write(review, { from: name });
      return { usage: { inputTokens: options.tokens ?? 100, outputTokens: 10 }, artifacts: review ? [review] : [], review, notes: [`${name} ok`] };
    },
  });
  return [make("analyze", "risk-map.json"), make("design", "test-plan.json"), make("execute"), make("triage")];
}

let store: RunStore;
test.beforeEach(async () => {
  store = { root: await mkdtemp(path.join(os.tmpdir(), "crew-")) };
});
test.afterEach(async () => {
  await rm(store.root, { recursive: true, force: true });
});

test("stages run in order and the run stops at a human gate", async () => {
  const calls: string[] = [];
  const stages = fakeStages(calls);
  const run = await advance(store, await createRun(store, { feature: "f", stages, gates: { analyze: "human" } }), stages);

  expect(calls).toEqual(["analyze"]);
  expect(run.status).toBe("waiting-for-approval");
  expect(run.waitingAt).toBe("analyze");
  expect(await decisionsFor(store, run)).toEqual([expect.objectContaining({ kind: "approve" })]);
});

test("an approval records who, when and what was approved, and the run continues", async () => {
  const calls: string[] = [];
  const stages = fakeStages(calls);
  let run = await advance(store, await createRun(store, { feature: "f", stages, gates: { analyze: "human" } }), stages);

  // The reviewer edits the risk map before approving: the fingerprint covers the edited file.
  await writeFile(path.join(store.root, run.id, "risk-map.json"), JSON.stringify({ edited: true }));
  run = await approve(store, run, { by: "enrique", note: "R6 rejected" });
  run = await advance(store, run, stages);

  expect(calls).toEqual(["analyze", "design", "execute", "triage"]);
  expect(run.status).toBe("done");
  expect(run.approvals).toEqual([expect.objectContaining({ gate: "analyze", mode: "human", by: "enrique", note: "R6 rejected", artifact: "risk-map.json" })]);
  expect(run.approvals[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(await changedSinceApproval(store, run, run.approvals[0])).toBe(false);

  // Changing the file after approval is visible in the summary.
  await writeFile(path.join(store.root, run.id, "risk-map.json"), JSON.stringify({ edited: "again" }));
  expect(await changedSinceApproval(store, run, run.approvals[0])).toBe(true);
  expect(await renderRunSummary(store, run)).toContain("the file changed after this approval");
});

test("auto gates are approved by policy, and the approval says so", async () => {
  const stages = fakeStages([]);
  const run = await advance(store, await createRun(store, { feature: "f", stages, gates: { analyze: "auto", design: "auto" } }), stages);

  expect(run.status).toBe("done");
  expect(run.approvals.map((a) => `${a.gate}:${a.mode}:${a.by}`)).toEqual(["analyze:auto:policy", "design:auto:policy"]);
});

test("you cannot approve a run that is not waiting", async () => {
  const stages = fakeStages([]);
  const run = await advance(store, await createRun(store, { feature: "f", stages }), stages);
  await expect(approve(store, run, { by: "x" })).rejects.toThrow(/not waiting/);
});

test("a failed stage stops the run, and continuing retries it without repeating finished stages", async () => {
  const calls: string[] = [];
  let run = await advance(store, await createRun(store, { feature: "f", stages: fakeStages(calls) }), fakeStages(calls, { failAt: "execute" }));

  expect(run.status).toBe("failed");
  expect(run.error).toContain("execute broke");
  expect(run.stages.map((s) => s.status)).toEqual(["done", "done", "failed", "pending"]);
  expect((await decisionsFor(store, run))[0].text).toContain("npm run crew -- continue");

  run = await advance(store, run, fakeStages(calls));
  expect(run.status).toBe("done");
  expect(calls).toEqual(["analyze", "design", "execute", "execute", "triage"]);
});

test("the run stops between stages when the token budget is spent", async () => {
  const calls: string[] = [];
  const stages = fakeStages(calls, { tokens: 600 });
  let run = await advance(store, await createRun(store, { feature: "f", stages, maxTokens: 1000 }), stages);

  expect(run.status).toBe("over-budget");
  expect(calls).toEqual(["analyze", "design"]);
  expect(run.usage).toEqual({ inputTokens: 1200, outputTokens: 20 });

  run.budget.maxTokens = 10_000;
  run = await advance(store, run, stages);
  expect(run.status).toBe("done");
  expect(calls).toEqual(["analyze", "design", "execute", "triage"]);
});

test("a run survives on disk: a new process loads it and carries on", async () => {
  const stages = fakeStages([]);
  const first = await advance(store, await createRun(store, { feature: "f", stages, gates: { design: "human" } }), stages);
  expect(first.status).toBe("waiting-for-approval");

  // Later, somewhere else: only the run id and the folder are needed.
  const id = await latestRunId(store);
  const again = await approve(store, await loadRun(store, id!), { by: "lead" });
  const done = await advance(store, again, stages);
  expect(done.status).toBe("done");

  const events = (await readFile(path.join(store.root, id!, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).type);
  expect(events).toEqual(["stage-start", "stage-end", "stage-start", "stage-end", "waiting", "approved", "stage-start", "stage-end", "stage-start", "stage-end", "run-done"]);
});

test.describe("the whole crew with scripted models", () => {
  test.setTimeout(240_000);

  test("analyze, design, execute and triage hand off through files, and the summary lists the decisions", async () => {
    const env = { ...process.env, QA_MODEL_PROVIDER: "mock", BOOKING_URL: `http://localhost:${process.env.APP_PORT ?? 3100}` };
    const stages = crewStages({ env });
    const run = await advance(store, await createRun(store, { feature: "booking-rules", stages, gates: { analyze: "auto", design: "auto" } }), stages);

    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(run.stages.map((s) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
    // Every hand-off is a file in the run folder.
    expect(run.stages.flatMap((s) => s.artifacts)).toEqual(
      expect.arrayContaining(["risk-map.json", "test-plan.json", "execution.json", "reviews.json", "triage.json"]),
    );
    // The scripted model's usage is estimated, so budgets work in demos too.
    expect(run.usage.inputTokens).toBeGreaterThan(1000);

    // The Reviewer caught TC-05 passing for the wrong reason; the revised test failed and became a new bug.
    const reviews = JSON.parse(await readFile(path.join(store.root, run.id, "reviews.json"), "utf8"));
    expect(reviews.map((r: { caseId: string; verdict: string }) => `${r.caseId}:${r.verdict}`)).toEqual(["TC-02:approve", "TC-05:request-changes", "TC-05:approve", "TC-08:approve"]);
    const execution = JSON.parse(await readFile(path.join(store.root, run.id, "execution.json"), "utf8"));
    expect(execution.find((r: { caseId: string }) => r.caseId === "TC-05")).toMatchObject({ outcome: "failing-suspected-product-bug", verified: true });

    const decisions = await decisionsFor(store, run);
    expect(decisions.map((d) => d.kind)).toEqual(expect.arrayContaining(["linked", "file-bug", "promote-test", "uncovered-risk"]));
    expect(decisions.find((d) => d.kind === "linked")?.text).toContain("ISSUE-0031");
    expect(decisions.find((d) => d.kind === "file-bug")?.text).toContain("TC-05");
    // TC-05's first version passed, but it is not offered for promotion: the review rejected it.
    expect(decisions.filter((d) => d.kind === "promote-test").map((d) => d.text)).toEqual([expect.stringContaining("TC-08")]);
  });
});
