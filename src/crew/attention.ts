import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadRun, type CrewRun, type RunStore } from "./orchestrator.ts";

// Chapter 13: the human is the scarcest resource in the crew.
//
// Agents scale with money. Review does not: one person has so many careful minutes a day,
// and quality is not something you can scale by reading faster. So the crew treats a person's
// attention as a budget, the way Chapter 9 treated tokens: it estimates what each decision
// costs, puts the most important ones first, and refuses to start work nobody can review.

/** The kinds of decision a run can leave for a person. */
export type DecisionKind =
  | "approve"
  | "file-bug"
  | "linked"
  | "fix-test"
  | "flaky"
  | "investigate"
  | "answer-question"
  | "uncovered-risk"
  | "promote-test"
  | "unverified";

/**
 * Minutes of careful attention a decision usually takes. These are starting estimates:
 * measure your own team and change them. What matters is that the cost is written down.
 */
export const REVIEW_MINUTES: Record<DecisionKind, number> = {
  approve: 10, // read a risk map or a test plan, and edit it
  unverified: 10, // an agent's claim that a re-run contradicts: read both
  investigate: 10, // the crew could not decide: read the evidence
  "file-bug": 5, // read a draft bug report, reproduce it, file it
  "fix-test": 5, // read the proposed change, apply it or not
  "promote-test": 5, // read a generated test before it joins the suite
  flaky: 5,
  "answer-question": 5, // often someone else's question to answer: route it
  "uncovered-risk": 3, // test it another way, or accept the risk
  linked: 2, // add the new evidence to an existing issue
};

/**
 * What to look at first: what blocks the crew, then what the crew could not settle,
 * then what reaches the product's backlog, then what reaches the test suite.
 */
const ORDER: DecisionKind[] = [
  "approve",
  "unverified",
  "investigate",
  "file-bug",
  "fix-test",
  "flaky",
  "answer-question",
  "uncovered-risk",
  "promote-test",
  "linked",
];

export function rankDecisions<T extends { kind: DecisionKind }>(decisions: T[]): (T & { minutes: number })[] {
  return decisions
    .map((d, i) => ({ d: { ...d, minutes: REVIEW_MINUTES[d.kind] }, i }))
    .sort((a, b) => ORDER.indexOf(a.d.kind) - ORDER.indexOf(b.d.kind) || a.i - b.i)
    .map(({ d }) => d);
}

export const attentionMinutes = (decisions: { minutes: number }[]) => decisions.reduce((sum, d) => sum + d.minutes, 0);

/** Runs that stopped at a gate and wait for a person. */
export async function runsWaitingForPeople(store: RunStore): Promise<CrewRun[]> {
  if (!existsSync(store.root)) return [];
  const ids = (await readdir(store.root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  const runs: CrewRun[] = [];
  for (const id of ids) {
    try {
      const run = await loadRun(store, id);
      if (run.status === "waiting-for-approval") runs.push(run);
    } catch {
      // Not a run folder: ignore it.
    }
  }
  return runs;
}

/** The default work-in-progress limit: how many runs may wait for a person at once. */
export const DEFAULT_MAX_WAITING = 2;

/**
 * A work-in-progress limit for agents. Starting another run while two already wait for a person
 * does not make the crew faster: it makes the queue longer, and the review of each item shorter.
 * Returns the reason to refuse, or undefined when there is room.
 */
export async function wipLimitReason(store: RunStore, limit = DEFAULT_MAX_WAITING): Promise<string | undefined> {
  const waiting = await runsWaitingForPeople(store);
  if (waiting.length < limit) return undefined;
  const list = waiting.map((r) => `${r.id} (${r.feature}, waiting at ${r.waitingAt})`).join(", ");
  return (
    `${waiting.length} runs already wait for a person: ${list}. ` +
    `Review them first. Do not run more agents than you can review. (Limit: QA_CREW_MAX_WAITING=${limit}.)`
  );
}
