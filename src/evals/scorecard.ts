import type { Usage } from "../llm/index.ts";
import type { Check } from "./scorers.ts";

// Chapter 12: from trials to a scorecard. One run of an agent is an anecdote.
// Several runs on the same input show what the model does on average, and how much it wobbles.

export interface Trial {
  /** Fraction of checks passed, 0..1. */
  score: number;
  checks: Check[];
  usage: Usage;
  steps: number;
  seconds: number;
  error?: string;
}

export interface CheckSummary {
  name: string;
  passed: number;
  of: number;
  /** The last detail seen when it failed, else when it passed. */
  detail?: string;
}

export interface SuiteReport {
  suite: string;
  model: string;
  trials: Trial[];
  mean: number;
  min: number;
  max: number;
  /** Standard deviation of the score across trials: 0 means the same result every time. */
  spread: number;
  checks: CheckSummary[];
  /** Mean per trial. */
  tokens: Usage;
  seconds: number;
  steps: number;
}

export interface Scorecard {
  label: string;
  createdAt: string;
  trials: number;
  suites: SuiteReport[];
}

export const scoreOf = (checks: Check[]) => (checks.length === 0 ? 0 : checks.filter((c) => c.passed).length / checks.length);

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarize(suite: string, model: string, trials: Trial[]): SuiteReport {
  const scores = trials.map((t) => t.score);
  const m = mean(scores);
  const spread = Math.sqrt(mean(scores.map((s) => (s - m) ** 2)));

  const byName = new Map<string, CheckSummary>();
  for (const t of trials) {
    for (const c of t.checks) {
      const s = byName.get(c.name) ?? { name: c.name, passed: 0, of: 0 };
      s.of++;
      if (c.passed) s.passed++;
      if (!c.passed || s.detail === undefined) s.detail = c.detail;
      byName.set(c.name, s);
    }
  }

  return {
    suite,
    model,
    trials,
    mean: m,
    min: scores.length ? Math.min(...scores) : 0,
    max: scores.length ? Math.max(...scores) : 0,
    spread,
    checks: [...byName.values()],
    tokens: { inputTokens: Math.round(mean(trials.map((t) => t.usage.inputTokens))), outputTokens: Math.round(mean(trials.map((t) => t.usage.outputTokens))) },
    seconds: mean(trials.map((t) => t.seconds)),
    steps: mean(trials.map((t) => t.steps)),
  };
}

/** A check that passed in some trials and failed in others: the model can do it, but you cannot count on it. */
export const unstable = (c: CheckSummary) => c.passed > 0 && c.passed < c.of;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function renderScorecard(card: Scorecard): string {
  const lines = [
    `# Eval scorecard: ${card.label}`,
    "",
    `${card.createdAt} · ${card.trials} trial${card.trials === 1 ? "" : "s"} per suite`,
    "",
    "| Suite | Model | Score | Range | Tokens in / out | Seconds |",
    "|---|---|---|---|---|---|",
  ];
  for (const s of card.suites) {
    lines.push(`| ${s.suite} | ${s.model} | ${pct(s.mean)} | ${pct(s.min)}–${pct(s.max)} | ${k(s.tokens.inputTokens)} / ${k(s.tokens.outputTokens)} | ${s.seconds.toFixed(1)} |`);
  }
  for (const s of card.suites) {
    lines.push("", `## ${s.suite}`, "", "| Check | Passed | Detail |", "|---|---|---|");
    for (const c of s.checks) {
      const mark = c.passed === c.of ? "✓" : c.passed === 0 ? "✗" : "~";
      lines.push(`| ${c.name} | ${mark} ${c.passed}/${c.of} | ${(c.detail ?? "").replace(/\|/g, "\\|")} |`);
    }
    const errors = s.trials.filter((t) => t.error);
    for (const t of errors) lines.push("", `Trial error: ${t.error}`);
  }
  lines.push("", "✓ passed every trial · ~ unstable: passed in some trials only · ✗ never passed");
  return lines.join("\n") + "\n";
}

/** Two scorecards side by side: the same suites, two models (or two prompts, or two commits). */
export function renderComparison(a: Scorecard, b: Scorecard): string {
  const lines = [`# ${a.label} vs ${b.label}`, "", `| Suite | ${a.label} | ${b.label} | Tokens in (${a.label}) | Tokens in (${b.label}) |`, "|---|---|---|---|---|"];
  const names = [...new Set([...a.suites, ...b.suites].map((s) => s.suite))];
  for (const name of names) {
    const sa = a.suites.find((s) => s.suite === name);
    const sb = b.suites.find((s) => s.suite === name);
    lines.push(`| ${name} | ${sa ? pct(sa.mean) : "–"} | ${sb ? pct(sb.mean) : "–"} | ${sa ? k(sa.tokens.inputTokens) : "–"} | ${sb ? k(sb.tokens.inputTokens) : "–"} |`);
  }
  lines.push("", "Checks that differ:", "");
  let differences = 0;
  for (const name of names) {
    const ca = new Map((a.suites.find((s) => s.suite === name)?.checks ?? []).map((c) => [c.name, c]));
    for (const cb of b.suites.find((s) => s.suite === name)?.checks ?? []) {
      const x = ca.get(cb.name);
      if (!x || x.passed / x.of === cb.passed / cb.of) continue;
      differences++;
      lines.push(`- ${name} · ${cb.name}: ${a.label} ${x.passed}/${x.of}, ${b.label} ${cb.passed}/${cb.of}`);
    }
  }
  if (differences === 0) lines.push("- none");
  return lines.join("\n") + "\n";
}
