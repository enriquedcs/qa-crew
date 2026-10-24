import type { Risk, TestCase, TestPlan } from "../../crew/contracts.ts";

// The "100 shallow tests" trap: a model will happily generate dozens of near-identical
// cases. Curation is code, so it is predictable: it removes duplicates, drops cases
// that trace to nothing, keeps a budget per risk, and ranks what is left.

/** How many cases each risk level deserves. More risk, more tests; never unlimited. */
export const DEFAULT_BUDGET = { high: 4, medium: 2, low: 1 } as const;

const PRIORITY_ORDER = { p1: 0, p2: 1, p3: 2 } as const;

export function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Jaccard similarity of two titles: 1 means the same words, 0 means nothing in common. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  const shared = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union === 0 ? 0 : shared / union;
}

/** Two cases are duplicates when they test the same layer with the same data and the same oracle. */
export function signature(c: TestCase): string {
  const data = JSON.stringify(Object.keys(c.data).sort().map((k) => [k, c.data[k]]));
  return `${c.layer}|${data}|${c.expected.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export interface CurateOptions {
  budget?: { high: number; medium: number; low: number };
  /** Titles at least this similar (and on the same layer and risk) count as duplicates. */
  similarityThreshold?: number;
}

export function curateTestPlan(plan: TestPlan, risks: Risk[], options: CurateOptions = {}): TestPlan {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const threshold = options.similarityThreshold ?? 0.8;
  const riskById = new Map(risks.map((r) => [r.id, r]));
  const riskScore = (c: TestCase) => Math.max(0, ...c.riskIds.map((id) => riskById.get(id)?.score ?? 0));

  const dropped: NonNullable<TestPlan["dropped"]> = [];
  const drop = (c: TestCase, reason: string) => dropped.push({ id: c.id, title: c.title, reason });

  // 1. Traceability: a case that protects against no known risk is noise.
  let cases = plan.cases.filter((c) => {
    const known = c.riskIds.filter((id) => riskById.has(id));
    if (known.length === 0) {
      drop(c, `traces to no risk in the risk map (${c.riskIds.join(", ") || "none"})`);
      return false;
    }
    return true;
  });

  // 2. Rank: highest risk first, then priority, so budgets keep the most valuable cases.
  cases = [...cases].sort(
    (a, b) => riskScore(b) - riskScore(a) || PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  );

  // 3. Duplicates: same signature, or near-identical titles for the same risk and layer.
  const kept: TestCase[] = [];
  for (const c of cases) {
    const twin = kept.find(
      (k) =>
        signature(k) === signature(c) ||
        (k.layer === c.layer && k.riskIds.some((r) => c.riskIds.includes(r)) && similarity(k.title, c.title) >= threshold),
    );
    if (twin) drop(c, `duplicate of ${twin.id}`);
    else kept.push(c);
  }

  // 4. Budget per risk: a case counts against its most serious risk.
  const used = new Map<string, number>();
  const final = kept.filter((c) => {
    const main = [...c.riskIds].filter((id) => riskById.has(id)).sort((a, b) => (riskById.get(b)?.score ?? 0) - (riskById.get(a)?.score ?? 0))[0];
    const level = riskById.get(main)?.level ?? "low";
    const count = used.get(main) ?? 0;
    if (count >= budget[level]) {
      drop(c, `over the budget of ${budget[level]} cases for ${level} risk ${main}`);
      return false;
    }
    used.set(main, count + 1);
    return true;
  });

  return { ...plan, cases: final, dropped };
}

/** Risks that ended up with no test case at all: a gap a human should see. */
export function uncoveredRisks(plan: TestPlan, risks: Risk[]): Risk[] {
  const covered = new Set(plan.cases.flatMap((c) => c.riskIds));
  return risks.filter((r) => !covered.has(r.id));
}
