import { readFileSync } from "node:fs";
import type { AgentEvent, Tool } from "../agent/runAgent.ts";
import type { EvidencePack, ExecutionReport, RiskMap, TestCase, TriageItem } from "../crew/contracts.ts";
import { risksForDesign } from "../agents/analyst/curate.ts";
import { runAnalyst } from "../agents/analyst/analyst.ts";
import { scriptedAnalyst } from "../agents/analyst/demo.ts";
import { curateTestPlan } from "../agents/designer/curate.ts";
import { scriptedDesigner } from "../agents/designer/demo.ts";
import { runDesigner } from "../agents/designer/designer.ts";
import { testDataTools } from "../agents/designer/testData.ts";
import { SCRIPTED_CREW_CASES, scriptedExecutor } from "../agents/executor/demo.ts";
import { runExecutor } from "../agents/executor/executor.ts";
import { calibrate, rubberStamp } from "../agents/reviewer/calibration.ts";
import { scriptedTriager } from "../agents/triager/demo.ts";
import { runTriager } from "../agents/triager/triager.ts";
import type { CrewRole } from "../agents/shared.ts";
import type { MockTurn, ModelClient, Usage } from "../llm/index.ts";
import { connectMcpServers, loadMcpConfig, type McpToolFilter } from "../mcp/connect.ts";
import { calibrateJudge, rubberStampJudge } from "./judge.ts";
import { scoreCalibration, scoreExecution, scoreJudgeCalibration, scoreRiskMap, scoreTestPlan, scoreTriage, type Check } from "./scorers.ts";

// Chapter 12: one suite per agent. A suite runs the agent on a fixed input and scores the output.
// The input never changes between trials or between models, so the only thing that varies is the model.

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

export interface TrialOutput {
  checks: Check[];
  usage: Usage;
  /** Model calls the agent made, summed over every agent run in the trial. */
  steps: number;
}

export interface Suite {
  name: CrewRole;
  description: string;
  /** The scripted model, for QA_MODEL_PROVIDER=mock. */
  script: () => MockTurn[];
  /** The least-privilege tools this agent gets in the crew. */
  tools: McpToolFilter;
  env?: Record<string, string>;
  /** Writes files and runs Playwright: slower, and only on request. */
  slow?: boolean;
  trial(model: ModelClient, tools: Tool[], onEvent?: (event: AgentEvent) => void): Promise<TrialOutput>;
}

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });
const ZERO: Usage = { inputTokens: 0, outputTokens: 0 };
const READ_ONLY: McpToolFilter = { readOnly: true };

export const SUITES: Suite[] = [
  {
    name: "analyst",
    description: "Risk map for booking-rules: must-find risks, grounding, the FR-007 question",
    script: () => scriptedAnalyst("booking-rules"),
    tools: READ_ONLY,
    async trial(model, tools, onEvent) {
      const { riskMap, run } = await runAnalyst({ model, tools, feature: "booking-rules", onEvent });
      return { checks: scoreRiskMap(riskMap), usage: run.usage, steps: run.steps };
    },
  },
  {
    name: "designer",
    description: "Test plan from a reviewed risk map: coverage, boundaries, oracles, open questions",
    script: () => scriptedDesigner("booking-rules"),
    tools: READ_ONLY,
    async trial(model, tools, onEvent) {
      const risks = risksForDesign(fixture<RiskMap>("risk-map.json"));
      const { run, plan } = await runDesigner({ model, tools: [...tools, ...testDataTools()], feature: "booking-rules", risks, onEvent });
      // Score what the model proposed AND what curation kept: curation hides mistakes from people, not from evals.
      const raw = run.output;
      return { checks: scoreTestPlan(raw, plan ?? (raw ? curateTestPlan(raw, risks) : undefined), risks), usage: run.usage, steps: run.steps };
    },
  },
  {
    name: "executor",
    description: "Three cases against the real app: does each one end the way the app really behaves?",
    script: () => scriptedExecutor(SCRIPTED_CREW_CASES),
    tools: { include: ["read_test_file", "list_test_files", "get_api_reference", "list_rooms", "write_generated_test", "run_generated_test"] },
    env: { QA_TOOLS_ALLOW_TEST_WRITES: "true" },
    slow: true,
    async trial(model, tools, onEvent) {
      const reports: ExecutionReport[] = [];
      let usage = ZERO;
      let steps = 0;
      for (const testCase of fixture<TestCase[]>("test-cases.json")) {
        const { report, run } = await runExecutor({ model, tools, testCase, onEvent });
        usage = add(usage, run.usage);
        steps += run.steps;
        if (report) reports.push(report);
      }
      return { checks: scoreExecution(reports), usage, steps };
    },
  },
  {
    name: "triager",
    description: "The demo red build, frozen: product bug, duplicate, test bug and flaky test",
    script: scriptedTriager,
    tools: { include: ["read_test_file", "list_requirements", "get_api_reference", "search_issues", "search_knowledge", "recent_changes"] },
    async trial(model, tools, onEvent) {
      const items: TriageItem[] = [];
      let usage = ZERO;
      let steps = 0;
      for (const pack of fixture<EvidencePack[]>("triage-evidence.json")) {
        const { item, run } = await runTriager({ model, tools, pack, onEvent });
        usage = add(usage, run.usage);
        steps += run.steps;
        if (item) items.push(item);
      }
      return { checks: scoreTriage(items), usage, steps };
    },
  },
  {
    name: "reviewer",
    description: "The calibration set from Chapter 10: 7 planted defects and 3 clean tests",
    script: () => rubberStamp(),
    tools: { include: ["read_test_file", "list_requirements", "get_api_reference"] },
    async trial(model, tools, onEvent) {
      const report = await calibrate(model, tools, undefined, onEvent);
      return { checks: scoreCalibration(report), usage: report.usage, steps: report.results.length };
    },
  },
  {
    name: "judge",
    description: "Chapter 14: the judge of the assistant's answers, on 9 labeled answers (6 with planted defects)",
    script: () => rubberStampJudge(),
    tools: { include: [] },
    async trial(model) {
      const { results, usage } = await calibrateJudge(model);
      return { checks: scoreJudgeCalibration(results), usage, steps: results.length };
    },
  },
];

/** Connect the suite's tools once; every trial reuses them. */
export async function connectSuiteTools(suite: Suite) {
  const servers = await loadMcpConfig(".mcp.json");
  const config = servers["qa-tools"];
  return connectMcpServers([{ name: "qa-tools", config: { ...config, env: { ...config.env, ...suite.env } }, filter: suite.tools }]);
}
