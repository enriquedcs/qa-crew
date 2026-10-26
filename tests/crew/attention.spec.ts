import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { attentionMinutes, rankDecisions, REVIEW_MINUTES, runsWaitingForPeople, wipLimitReason } from "../../src/crew/attention.ts";
import { advance, createRun, type RunStore, type Stage } from "../../src/crew/orchestrator.ts";
import { renderRunSummary } from "../../src/crew/summary.ts";

const gateStages = (): Stage[] =>
  ["analyze", "design"].map((name) => ({
    name,
    title: name,
    async run(ctx) {
      await ctx.write(`${name}.json`, { from: name });
      return { usage: { inputTokens: 10, outputTokens: 1 }, artifacts: [`${name}.json`], review: `${name}.json`, notes: [] };
    },
  }));

let store: RunStore;
test.beforeEach(async () => {
  store = { root: await mkdtemp(path.join(os.tmpdir(), "attention-")) };
});
test.afterEach(async () => {
  await rm(store.root, { recursive: true, force: true });
});

async function runToGate(feature: string) {
  const stages = gateStages();
  return advance(store, await createRun(store, { feature, stages, gates: { analyze: "human" } }), stages);
}

test("decisions are ranked: what blocks the crew first, what reaches the suite last", () => {
  const ranked = rankDecisions([
    { kind: "linked" as const, text: "a" },
    { kind: "promote-test" as const, text: "b" },
    { kind: "file-bug" as const, text: "c" },
    { kind: "approve" as const, text: "d" },
    { kind: "file-bug" as const, text: "e" },
  ]);
  expect(ranked.map((d) => d.text)).toEqual(["d", "c", "e", "b", "a"]);
  expect(ranked[0].minutes).toBe(REVIEW_MINUTES.approve);
  expect(attentionMinutes(ranked)).toBe(10 + 5 + 5 + 5 + 2);
});

test("the summary states how much attention the run asks for", async () => {
  const run = await runToGate("booking");
  const summary = await renderRunSummary(store, run);
  expect(summary).toContain("## Your decisions (about 10 minutes)");
  expect(summary).toMatch(/- \[ \] \(10 min\) Review/);
});

test("a work-in-progress limit: no new run while too many wait for a person", async () => {
  expect(await wipLimitReason(store, 2)).toBeUndefined();
  await runToGate("first");
  expect(await wipLimitReason(store, 2)).toBeUndefined();
  await runToGate("second");

  expect((await runsWaitingForPeople(store)).map((r) => r.feature).sort()).toEqual(["first", "second"]);
  const reason = await wipLimitReason(store, 2);
  expect(reason).toContain("2 runs already wait for a person");
  expect(reason).toContain("Do not run more agents than you can review");
  expect(await wipLimitReason(store, 3)).toBeUndefined();
});
