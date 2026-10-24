import { readdir } from "node:fs/promises";
import { runAgent, type AgentEvent, type AgentResult, type Tool } from "../../agent/runAgent.ts";
import { triageItemSchema, type EvidencePack, type TriageItem } from "../../crew/contracts.ts";
import type { ModelClient } from "../../llm/types.ts";
import { applyGuards } from "./guards.ts";

// The Triager: one failure at a time, from evidence to a classification a team can act on.
// It reads; it never edits tests or code. For a test bug it proposes a change, and a human makes it.

export const TRIAGER_SYSTEM = `You are the Triager on a QA team. A test failed. You decide why, and you write it up
so that the right person can act without investigating from scratch.

You receive an evidence pack: the failing test's source, the error, the outcome of several runs,
and whether the application was healthy. Use your tools to look further: the requirements,
the issue tracker, the team's past bugs, and recent changes to the application.

Classify the failure as exactly one of:
- product-bug: the test is correct and the application breaks a requirement. Every run fails the same way.
- test-bug: the application behaves correctly and the test is wrong: a locator that matches nothing,
  wrong setup, a wrong import, an assertion about something no requirement says.
- environment: the application or a dependency was not available (connection refused, server did not start).
- flaky: the same test both passes and fails without any change. Look for the race: a short wait,
  shared state between tests, order dependence, time of day, random data.
- needs-human: the evidence does not support any of the above with confidence.

Rules:
- Base the classification on the evidence, not on the test's title. Quote the evidence.
- A failing assertion on the expected result (status, message, stored state) is a product bug
  unless you can show the expectation itself is wrong, with a requirement.
- Before you write a bug report, search the issue tracker. If the same problem is already reported
  (open or closed), set duplicateOf to its id and do not write a new report.
- A bug report is for a developer: what is broken for the user, exact steps with real values,
  expected (cite the requirement id), actual, and where in the code the fix probably belongs.
- For a test bug, propose the smallest change that makes the test check the same thing correctly.
  Never propose changing what the test expects, removing assertions, adding retries or skipping the test.
- For a flaky test, name the most likely cause. Do not propose retries as the fix.
When you are done, call submit_result.`;

export interface TriagerOptions {
  model: ModelClient;
  tools: Tool[];
  pack: EvidencePack;
  issuesDir?: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export async function knownIssueIds(issuesDir = "issues"): Promise<Set<string>> {
  try {
    return new Set((await readdir(issuesDir)).map((f) => f.match(/^(ISSUE-\d+)/)?.[1]).filter((id): id is string => !!id));
  } catch {
    return new Set();
  }
}

/** What the model sees: the facts, compact. */
export function briefFor(pack: EvidencePack): string {
  const runs = pack.runs.map((r, i) => `  run ${i + 1}: ${r.status}${r.error ? ` — ${r.error.split("\n").slice(0, 6).join(" | ")}` : ""}`);
  return [
    `Failing test: "${pack.failure.title}" in ${pack.failure.file}`,
    pack.failure.caseId ? `Test case: ${pack.failure.caseId}` : "",
    pack.failure.expected ? `Expected by the test plan: ${pack.failure.expected}` : "",
    `Runs (original first):`,
    ...runs,
    `Every run failed the same way: ${pack.consistent ? "yes" : "no"}`,
    `Application healthy during the runs: ${pack.appHealthy ? "yes" : "no"}`,
    `Test source:`,
    "```typescript",
    pack.testSource.trim(),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runTriager(
  options: TriagerOptions,
): Promise<{ item?: TriageItem; run: AgentResult<Omit<TriageItem, "file" | "title">> }> {
  const { model, tools, pack, issuesDir = "issues", maxSteps = 10, onEvent } = options;

  const run = await runAgent<Omit<TriageItem, "file" | "title">>({
    model,
    system: TRIAGER_SYSTEM,
    task: `Triage this failure.\n\n${briefFor(pack)}`,
    tools,
    output: { schema: triageItemSchema, description: "Submit your triage of this one failure." },
    maxSteps,
    onEvent,
  });

  if (!run.output) return { run };
  const item: TriageItem = {
    ...run.output,
    file: pack.failure.file,
    title: pack.failure.title,
    ...(pack.failure.caseId ? { caseId: pack.failure.caseId } : {}),
  };
  return { run, item: applyGuards(item, pack, await knownIssueIds(issuesDir)) };
}

// ---------- Rendering for humans ----------

const LABEL: Record<TriageItem["classification"], string> = {
  "product-bug": "Product bug",
  "test-bug": "Test bug",
  environment: "Environment",
  flaky: "Flaky",
  "needs-human": "Needs a human",
};

export function renderTriage(items: TriageItem[]): string {
  const lines = ["# Triage", "", "| Test | Classification | Confidence | Action |", "|---|---|---|---|"];
  for (const i of items) {
    const action = i.duplicateOf
      ? `Already reported: ${i.duplicateOf}`
      : i.bugReport
        ? "File the draft bug report"
        : i.testFix
          ? "Fix the test (proposed change below)"
          : i.classification === "flaky"
            ? "Fix the race; do not add retries"
            : "Investigate";
    lines.push(`| ${i.title} | ${LABEL[i.classification]} | ${i.confidence} | ${action} |`);
  }
  for (const i of items) {
    lines.push("", `## ${i.title}`, "", `**${LABEL[i.classification]}** (${i.confidence} confidence). ${i.rationale}`, "");
    for (const e of i.evidence) lines.push(`- ${e}`);
    for (const w of i.warnings ?? []) lines.push(`- ⚠ ${w}`);
    if (i.testFix) lines.push("", `**Proposed test change:** ${i.testFix.summary}`, "", "```", i.testFix.change, "```");
    if (i.flakinessCause) lines.push("", `**Likely cause of flakiness:** ${i.flakinessCause}`);
  }
  return lines.join("\n") + "\n";
}

export function renderBugReport(item: TriageItem): string | undefined {
  const r = item.bugReport;
  if (!r) return undefined;
  return [
    `# ${r.title}`,
    "",
    `- **Severity:** ${r.severity}`,
    `- **Requirements:** ${r.requirementIds.join(", ") || "none"}`,
    `- **Suspected area:** ${r.suspectedArea}`,
    `- **Found by:** ${item.file}${item.caseId ? ` (${item.caseId})` : ""}`,
    "",
    "## Summary",
    "",
    r.summary,
    "",
    "## Steps to reproduce",
    "",
    ...r.stepsToReproduce.map((s, n) => `${n + 1}. ${s}`),
    "",
    `**Expected:** ${r.expected}`,
    "",
    `**Actual:** ${r.actual}`,
    "",
    "## Evidence",
    "",
    ...item.evidence.map((e) => `- ${e}`),
    "",
    "_Draft written by the Triager agent. Review before filing._",
    "",
  ].join("\n");
}
