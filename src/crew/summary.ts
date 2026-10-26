import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExecutionReport, Review, Risk, RiskMap, TestPlan, TriageItem } from "./contracts.ts";
import { attentionMinutes, rankDecisions, type DecisionKind } from "./attention.ts";
import { changedSinceApproval, runDir, type CrewRun, type RunStore } from "./orchestrator.ts";

// The run summary is the test lead's inbox: what the crew did, what it cost,
// and every decision that is still yours to make.

const GATE_LABEL: Record<string, string> = { analyze: "the risk map", design: "the test plan", review: "the reviewed tests" };

async function readJson<T>(dir: string, name: string): Promise<T | undefined> {
  const file = path.join(dir, name);
  return existsSync(file) ? (JSON.parse(await readFile(file, "utf8")) as T) : undefined;
}

function duration(start?: string, end?: string): string {
  if (!start || !end) return "";
  const s = Math.round((Date.parse(end) - Date.parse(start)) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export interface Decision {
  kind: DecisionKind;
  text: string;
  /** Estimated minutes of a person's attention (Chapter 13). */
  minutes: number;
}

/** Everything a human still has to decide, read from the run's files, most important first. */
export async function decisionsFor(store: RunStore, run: CrewRun): Promise<Decision[]> {
  return rankDecisions(await collectDecisions(store, run));
}

async function collectDecisions(store: RunStore, run: CrewRun): Promise<Omit<Decision, "minutes">[]> {
  const dir = runDir(store, run.id);
  const out: Omit<Decision, "minutes">[] = [];

  if (run.status === "waiting-for-approval" && run.waitingAt) {
    const stage = run.stages.find((s) => s.name === run.waitingAt);
    out.push({
      kind: "approve",
      text: `Review ${GATE_LABEL[run.waitingAt] ?? run.waitingAt} in \`${path.join(dir, stage?.review ?? "")}\`, edit it if needed, then run \`npm run crew -- approve\`.`,
    });
  }

  if (run.status === "over-budget") {
    out.push({ kind: "investigate", text: `The run stopped at its token budget. Continue with a larger one: \`npm run crew -- continue --max-tokens ${run.budget.maxTokens * 2}\`, or stop here.` });
  }
  if (run.status === "failed") {
    out.push({ kind: "investigate", text: `${(run.error ?? "A stage failed").replace(/\.?$/, ".")} Fix the cause, then \`npm run crew -- continue\`: finished stages are not repeated.` });
  }

  const plan = await readJson<TestPlan>(dir, "test-plan.json");
  const uncovered = (await readJson<Risk[]>(dir, "uncovered-risks.json")) ?? [];
  const reports = (await readJson<ExecutionReport[]>(dir, "execution.json")) ?? [];
  const triage = (await readJson<TriageItem[]>(dir, "triage.json")) ?? [];
  const reviews = (await readJson<Review[]>(dir, "reviews.json")) ?? [];
  const lastReview = new Map(reviews.map((r) => [r.caseId, r]));

  for (const c of plan?.cases?.filter((c) => c.blockedBy) ?? []) {
    out.push({ kind: "answer-question", text: `${c.id} waits on an open question: ${c.blockedBy}` });
  }
  for (const r of uncovered) out.push({ kind: "uncovered-risk", text: `${r.id} (${r.level}) has no test case: test it another way, or accept the risk. ${r.title}` });

  for (const i of triage) {
    const who = i.caseId ?? i.title;
    if (i.duplicateOf) out.push({ kind: "linked", text: `${who} is already reported as ${i.duplicateOf}. Add the new evidence to it.` });
    else if (i.classification === "product-bug" && i.bugReport) out.push({ kind: "file-bug", text: `${who}: review and file the draft bug report "${i.bugReport.title}" (issues/DRAFT-${i.caseId ?? ""}.md).` });
    else if (i.classification === "test-bug") out.push({ kind: "fix-test", text: `${who}: the test is wrong. Apply the proposed change: ${i.testFix?.summary ?? "see triage.md"}` });
    else if (i.classification === "flaky") out.push({ kind: "flaky", text: `${who} is flaky: ${i.flakinessCause ?? "see triage.md"}` });
    else out.push({ kind: "investigate", text: `${who} needs a human: ${(i.warnings ?? [i.rationale]).join(" ")}` });
  }

  for (const r of reports.filter((r) => r.verified === false)) {
    out.push({ kind: "unverified", text: `${r.caseId}: the re-run did not confirm "${r.outcome}". ${r.verification ?? ""}` });
  }
  for (const r of lastReview.values()) {
    if (r.verdict === "request-changes") {
      out.push({ kind: "investigate", text: `${r.caseId}: the Reviewer still requests changes after ${r.round ?? 1} round(s). Read reviews.md and decide: ${r.summary}` });
    } else if (r.warnings?.length) {
      out.push({ kind: "investigate", text: `${r.caseId}: the review was approved with warnings: ${r.warnings.join(" ")}` });
    }
  }
  for (const r of reports.filter((r) => r.outcome === "passed" && r.verified)) {
    const review = lastReview.get(r.caseId);
    if (review && review.verdict !== "approve") continue;
    const reviewed = review ? ", verified and approved by the Reviewer" : " and was verified (not reviewed)";
    out.push({ kind: "promote-test", text: `${r.caseId} passed${reviewed}: read tests/generated/${r.file} and promote it if it is worth keeping.` });
  }
  return out;
}

export async function renderRunSummary(store: RunStore, run: CrewRun, titles: Record<string, string> = {}): Promise<string> {
  const dir = runDir(store, run.id);
  const statusLine: Record<CrewRun["status"], string> = {
    running: "Running.",
    "waiting-for-approval": `Waiting for your approval of ${GATE_LABEL[run.waitingAt ?? ""] ?? run.waitingAt}.`,
    done: "Done.",
    failed: `Failed. ${run.error ?? ""}`,
    "over-budget": `Stopped: over budget. ${run.error ?? ""}`,
  };
  const used = run.usage.inputTokens + run.usage.outputTokens;

  const lines = [
    `# Crew run ${run.id}`,
    "",
    `**Feature:** ${run.feature}  `,
    `**Status:** ${statusLine[run.status]}  `,
    `**Tokens:** ${tokens(used)} of a ${tokens(run.budget.maxTokens)} budget`,
    "",
    "| Stage | Status | Tokens | Time | Result |",
    "|---|---|---|---|---|",
  ];
  for (const s of run.stages) {
    const t = s.usage.inputTokens + s.usage.outputTokens;
    lines.push(`| ${titles[s.name] ?? s.name} | ${s.status} | ${t ? tokens(t) : ""} | ${duration(s.startedAt, s.finishedAt)} | ${(s.error ? [`Error: ${s.error}`] : s.notes.slice(0, 1)).join(" ")} |`);
  }

  if (run.approvals.length > 0) {
    lines.push("", "## Approvals", "");
    for (const a of run.approvals) {
      const changed = (await changedSinceApproval(store, run, a)) ? " ⚠ the file changed after this approval" : "";
      lines.push(`- **${GATE_LABEL[a.gate] ?? a.gate}**: ${a.mode === "human" ? `approved by ${a.by}` : "approved by policy (auto)"} at ${a.at}${a.sha256 ? `, sha256 ${a.sha256.slice(0, 12)}` : ""}${a.note ? ` — "${a.note}"` : ""}${changed}`);
    }
  }

  const decisions = await decisionsFor(store, run);
  const minutes = attentionMinutes(decisions);
  lines.push("", `## Your decisions${decisions.length ? ` (about ${minutes} minutes)` : ""}`, "");
  if (decisions.length === 0) lines.push("Nothing waits for you.");
  else lines.push("Most important first. The minutes are estimates of careful review, not of skimming.", "");
  for (const d of decisions) lines.push(`- [ ] (${d.minutes} min) ${d.text}`);

  const riskMap = await readJson<RiskMap>(dir, "risk-map.json");
  const files = [...new Set(run.stages.flatMap((s) => s.artifacts))];
  if (riskMap || files.length) {
    lines.push("", "## Files", "");
    for (const f of files) lines.push(`- \`${path.join(dir, f)}\``);
  }
  return lines.join("\n") + "\n";
}
