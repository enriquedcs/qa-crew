import { runAgent, type AgentEvent, type AgentResult, type Tool } from "../../agent/runAgent.ts";
import { riskMapSchema, type RiskMap } from "../../crew/contracts.ts";
import type { ModelClient } from "../../llm/types.ts";
import { loadRequirements } from "../../specs/requirements.ts";
import { curateRiskMap } from "./curate.ts";

// The Analyst: reads requirements and turns them into a risk map a human can review.
// It does not design tests. Its whole job is to say where testing effort should go, and why.

export const ANALYST_SYSTEM = `You are the Analyst on a QA team. You read requirements before anyone writes tests,
and you decide where testing effort should go. You do not write test cases.

How you work:
1. Read the requirements for the feature with list_requirements. Note every open question already marked.
2. Read the API reference and the live rooms, so your risks are about this product, not booking apps in general.
3. Read the existing tests (list_test_files, read_test_file) and the trace (trace_requirements), so you know what is already covered.
4. Search the team's knowledge (search_knowledge) for past bugs in the same areas. History is the best predictor of risk.
5. Then produce a risk map.

For each risk:
- Say what could go wrong for a real user or the business, not "test X".
- Link it to the requirement ids it threatens. If no requirement covers it, leave requirementIds empty and also list it under missingRequirements.
- Score impact (1-5: how bad if it happens) and likelihood (1-5: how likely, given the evidence). Explain both in the rationale.
- List evidence: quote the requirement, name the past bug, describe what the existing tests do or do not check.

Look especially for:
- Ambiguity: words like "today", "valid", "fast", "user-friendly" without a definition.
- Rules enforced in only one place (UI but not API, or the reverse).
- Boundaries: first, last, zero, maximum, the day of check-out.
- State and time: what happens after cancellation, across midnight, under concurrent requests.
- Requirements that contradict each other, and behavior no requirement mentions.

Do not invent requirement ids. Only use ids returned by list_requirements.
Prefer 5-10 sharp risks to 30 vague ones.
When you are done, call submit_result with the risk map.`;

export interface AnalystOptions {
  model: ModelClient;
  tools: Tool[];
  /** The requirements document to analyze, for example "booking-rules". */
  feature: string;
  projectRoot?: string;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
}

export interface AnalystResult {
  riskMap?: RiskMap;
  run: AgentResult<RiskMap>;
}

export async function runAnalyst(options: AnalystOptions): Promise<AnalystResult> {
  const { model, tools, feature, projectRoot = ".", maxSteps = 16, onEvent } = options;

  const run = await runAgent<RiskMap>({
    model,
    system: ANALYST_SYSTEM,
    task: `Analyze the requirements document "${feature}" and produce its risk map.`,
    tools,
    output: { schema: riskMapSchema, description: "Submit the finished risk map. Call this exactly once." },
    maxSteps,
    onEvent,
  });

  if (!run.output) return { run };

  // Ground the model's claims against the source: which requirement ids really exist?
  const docs = await loadRequirements(projectRoot);
  const knownIds = docs.flatMap((d) => d.requirements.map((r) => r.id));
  return { run, riskMap: curateRiskMap(run.output, knownIds) };
}
