import { runAgent, type AgentEvent, type AgentResult, type Tool } from "../../agent/runAgent.ts";
import { testPlanSchema, type Risk, type Technique, type TestPlan } from "../../crew/contracts.ts";
import type { ModelClient } from "../../llm/types.ts";
import { curateTestPlan, uncoveredRisks, type CurateOptions } from "./curate.ts";
import { techniquesPrompt } from "./techniques.ts";

// The Designer: turns accepted risks into a small set of test cases worth keeping.

export function designerSystem(techniques?: Technique[]): string {
  return `You are the Designer on a QA team. The Analyst gives you a risk map; you turn each risk into the
few test cases that would catch it. You do not write code.

How you work:
1. Read the requirements and the API reference, so every case uses real endpoints, fields and messages.
2. Read the existing tests, so you never propose a case that already exists.
3. For each risk, highest score first, pick the technique that fits and design the cases.

Test design techniques:
${techniquesPrompt(techniques)}

Rules for every case:
- One case, one reason to fail. Name that reason in the title.
- Link it to the risk ids it protects against, and to the requirement ids it checks.
- Make the oracle precise: the status code, the exact error message from the API or requirements,
  and the state that must or must not change (for example "no booking is stored").
- Use concrete data. Describe dates as offsets from today (checkInDays, checkOutDays), never as fixed dates.
  Use boundary_values for limits, relative_dates to reason about dates, and safe_guest_names for people.
- Choose the cheapest layer that can catch the bug: "api" unless the risk is about what the user sees or does.
- p1 = would block a release, p2 = should be fixed soon, p3 = nice to know.
- If the expected result depends on an open question, still design the case, but set blockedBy to the question.
  Blocked cases are not automated until someone answers it.

Quality over quantity. A high risk deserves a few sharp cases; a low risk deserves one, or none.
When you are done, call submit_result with the test plan.`;
}

export interface DesignerOptions {
  model: ModelClient;
  tools: Tool[];
  feature: string;
  risks: Risk[];
  techniques?: Technique[];
  curate?: CurateOptions;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface DesignerResult {
  plan?: TestPlan;
  uncovered: Risk[];
  run: AgentResult<TestPlan>;
}

export async function runDesigner(options: DesignerOptions): Promise<DesignerResult> {
  const { model, tools, feature, risks, techniques, maxSteps = 16, onEvent } = options;

  // Only what the Designer needs from each risk, so the context stays small.
  const brief = risks.map(({ id, title, requirementIds, level, score, rationale, evidence }) => ({
    id,
    title,
    requirementIds,
    level,
    score,
    rationale,
    evidence,
  }));

  const run = await runAgent<TestPlan>({
    model,
    system: designerSystem(techniques),
    task: `Design test cases for the feature "${feature}" from these accepted risks:\n${JSON.stringify(brief, null, 2)}`,
    tools,
    output: { schema: testPlanSchema, description: "Submit the test plan. Call this exactly once." },
    maxSteps,
    onEvent,
  });

  if (!run.output) return { run, uncovered: risks };
  const plan = curateTestPlan(run.output, risks, options.curate);
  return { run, plan, uncovered: uncoveredRisks(plan, risks) };
}

export function renderTestPlan(plan: TestPlan, uncovered: Risk[] = []): string {
  const lines = [`# Test plan: ${plan.feature}`, "", `${plan.cases.length} cases.`, ""];
  lines.push("| Case | Risk | Technique | Layer | Priority | Expected |", "|---|---|---|---|---|---|");
  for (const c of plan.cases) {
    const blocked = c.blockedBy ? ` **Blocked:** ${c.blockedBy}` : "";
    lines.push(`| **${c.id}** ${c.title} | ${c.riskIds.join(", ")} | ${c.technique} | ${c.layer} | ${c.priority} | ${c.expected}${blocked} |`);
  }
  if (uncovered.length > 0) {
    lines.push("", "## Risks with no test case", "");
    for (const r of uncovered) lines.push(`- **${r.id}** ${r.title} (${r.level}) — decide: test it another way, or accept the risk.`);
  }
  if (plan.dropped && plan.dropped.length > 0) {
    lines.push("", "## Removed by curation", "");
    for (const d of plan.dropped) lines.push(`- ${d.id} "${d.title}": ${d.reason}`);
  }
  return lines.join("\n") + "\n";
}
