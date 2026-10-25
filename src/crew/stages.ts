import { readFile } from "node:fs/promises";
import type { AgentEvent } from "../agent/runAgent.ts";
import { runAnalyst } from "../agents/analyst/analyst.ts";
import { risksForDesign } from "../agents/analyst/curate.ts";
import { scriptedAnalyst } from "../agents/analyst/demo.ts";
import { renderRiskMap } from "../agents/analyst/render.ts";
import { scriptedDesigner } from "../agents/designer/demo.ts";
import { renderTestPlan, runDesigner } from "../agents/designer/designer.ts";
import { testDataTools } from "../agents/designer/testData.ts";
import { SCRIPTED_CREW_CASES, scriptedExecutor, scriptedExecutorRevision } from "../agents/executor/demo.ts";
import { scriptedReviewer } from "../agents/reviewer/demo.ts";
import { renderReviews, revisionRequest, runReviewer } from "../agents/reviewer/reviewer.ts";
import { runExecutor } from "../agents/executor/executor.ts";
import { modelForRole, printEvents } from "../agents/shared.ts";
import { scriptedCrewTriager } from "../agents/triager/demo.ts";
import { collectEvidence, failuresFromExecution } from "../agents/triager/evidence.ts";
import { renderBugReport, renderTriage, runTriager } from "../agents/triager/triager.ts";
import type { Usage } from "../llm/types.ts";
import { connectMcpServers, loadMcpConfig, type McpToolFilter } from "../mcp/connect.ts";
import type { ExecutionReport, Review, RiskMap, TestPlan, TriageItem } from "./contracts.ts";
import type { Stage } from "./orchestrator.ts";

// The four stages of a QA Crew run. Each stage is one agent with its own tools (least privilege),
// reading the previous stage's file from the run folder and writing its own.

export interface CrewStageOptions {
  /** Print every agent step. Off in tests. */
  verbose?: boolean;
  /** Which test cases the Executor automates. Default: the p1 cases (the scripted demo: TC-02, TC-05 and TC-08). */
  caseIds?: string[];
  /** How many times a test may be revised after a review asks for changes. Default 1. */
  reviewRounds?: number;
  env?: NodeJS.ProcessEnv;
}

const add = (a: Usage, b: Usage): Usage => ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens });
const NONE: Usage = { inputTokens: 0, outputTokens: 0 };
const n = (count: number, word: string, plural = `${word}s`) => `${count} ${count === 1 ? word : plural}`;

async function qaTools(filter: McpToolFilter, env: NodeJS.ProcessEnv, extraEnv: Record<string, string> = {}) {
  const servers = await loadMcpConfig(".mcp.json", env);
  const config = servers["qa-tools"];
  return connectMcpServers([{ name: "qa-tools", config: { ...config, env: { ...config.env, ...extraEnv } }, filter }]);
}

export function crewStages(options: CrewStageOptions = {}): Stage[] {
  const env = options.env ?? process.env;
  const mock = (env.QA_MODEL_PROVIDER ?? "").toLowerCase() === "mock";
  const events = (prefix: string): ((e: AgentEvent) => void) | undefined => (options.verbose ? printEvents(prefix) : undefined);

  const analyze: Stage = {
    name: "analyze",
    title: "Analyst: requirements → risk map",
    async run(ctx) {
      const model = modelForRole("analyst", () => scriptedAnalyst(ctx.run.feature), env);
      const toolbox = await qaTools({ readOnly: true }, env);
      try {
        const { riskMap, run } = await runAnalyst({ model, tools: toolbox.tools, feature: ctx.run.feature, onEvent: events("  ") });
        if (!riskMap) throw new Error(`the Analyst produced no risk map (${run.status} after ${run.steps} steps)`);
        await ctx.write("risk-map.json", riskMap);
        await ctx.write("risk-map.md", renderRiskMap(riskMap));
        const high = riskMap.risks.filter((r) => r.level === "high").length;
        const warned = riskMap.risks.filter((r) => r.warnings?.length).length;
        return {
          usage: run.usage,
          artifacts: ["risk-map.json", "risk-map.md"],
          review: "risk-map.json",
          notes: [
            `${n(riskMap.risks.length, "risk")} (${high} high), ${n(riskMap.questions.length, "open question")}, ${n(riskMap.missingRequirements.length, "possibly missing requirement")}.`,
            ...(warned ? [`${n(warned, "risk carries a warning", "risks carry warnings")}: check before approving.`] : []),
            `${model.provider} / ${model.model}`,
          ],
        };
      } finally {
        await toolbox.close();
      }
    },
  };

  const design: Stage = {
    name: "design",
    title: "Designer: risks → test plan",
    async run(ctx) {
      // Fail at the seam: check the hand-off before spending tokens on it.
      if (!ctx.exists("risk-map.json")) throw new Error("no risk-map.json in the run folder");
      const riskMap = await ctx.readJson<RiskMap>("risk-map.json");
      const risks = risksForDesign(riskMap);
      if (risks.length === 0) throw new Error("every risk in the risk map was rejected: there is nothing to design");

      const model = modelForRole("designer", () => scriptedDesigner(ctx.run.feature), env);
      const toolbox = await qaTools({ readOnly: true }, env);
      try {
        const { plan, uncovered, run } = await runDesigner({
          model,
          tools: [...toolbox.tools, ...testDataTools()],
          feature: ctx.run.feature,
          risks,
          onEvent: events("  "),
        });
        if (!plan) throw new Error(`the Designer produced no test plan (${run.status} after ${run.steps} steps)`);
        await ctx.write("test-plan.json", plan);
        await ctx.write("test-plan.md", renderTestPlan(plan, uncovered));
        await ctx.write("uncovered-risks.json", uncovered);
        const blocked = plan.cases.filter((c) => c.blockedBy).length;
        return {
          usage: run.usage,
          artifacts: ["test-plan.json", "test-plan.md", "uncovered-risks.json"],
          review: "test-plan.json",
          notes: [
            `${n(plan.cases.length, "case")} kept from ${n(risks.length, "risk")}; ${plan.dropped?.length ?? 0} removed by curation; ${blocked} blocked by open questions.`,
            ...(uncovered.length ? [`${n(uncovered.length, "risk has", "risks have")} no test case: ${uncovered.map((r) => r.id).join(", ")}.`] : []),
            `${model.provider} / ${model.model}`,
          ],
        };
      } finally {
        await toolbox.close();
      }
    },
  };

  const execute: Stage = {
    name: "execute",
    title: "Executor: test cases → Playwright tests, run and verified",
    async run(ctx) {
      if (!ctx.exists("test-plan.json")) throw new Error("no test-plan.json in the run folder");
      const plan = await ctx.readJson<TestPlan>("test-plan.json");
      const wanted = options.caseIds ?? (mock ? SCRIPTED_CREW_CASES : plan.cases.filter((c) => c.priority === "p1").map((c) => c.id));
      const cases = plan.cases.filter((c) => wanted.includes(c.id));
      if (cases.length === 0) return { skipped: true, notes: ["No cases to automate in the approved plan."] };

      // Resume: cases finished in an earlier attempt are not repeated.
      const reports: ExecutionReport[] = ctx.exists("execution.json") ? await ctx.readJson<ExecutionReport[]>("execution.json") : [];
      const model = modelForRole("executor", () => scriptedExecutor(wanted), env);
      const toolbox = await qaTools(
        { include: ["read_test_file", "list_test_files", "get_api_reference", "list_rooms", "write_generated_test", "run_generated_test"] },
        env,
        { QA_TOOLS_ALLOW_TEST_WRITES: "true" },
      );
      let usage = NONE;
      const notes: string[] = [];
      try {
        for (const testCase of cases) {
          if (reports.some((r) => r.caseId === testCase.id)) continue;
          if (ctx.tokensLeft(usage.inputTokens + usage.outputTokens) <= 0) {
            notes.push(`Stopped before ${testCase.id}: the run's token budget is spent.`);
            break;
          }
          if (options.verbose) console.log(`  --- ${testCase.id} ${testCase.title}`);
          const { report, run } = await runExecutor({ model, tools: toolbox.tools, testCase, onEvent: events("    ") });
          usage = add(usage, run.usage);
          reports.push(report ?? { caseId: testCase.id, file: "", outcome: "blocked", attempts: 0, evidence: "", notes: `No report (${run.status}).` });
          await ctx.write("execution.json", reports);
        }
      } finally {
        await toolbox.close();
      }
      await ctx.write("execution.json", reports);
      const count = (o: ExecutionReport["outcome"]) => reports.filter((r) => r.outcome === o).length;
      const unverified = reports.filter((r) => r.verified === false).length;
      return {
        usage,
        artifacts: ["execution.json"],
        notes: [
          `${n(reports.length, "case")}: ${count("passed")} passed, ${n(count("failing-suspected-product-bug"), "suspected product bug")}, ${count("blocked")} blocked.`,
          ...(unverified ? [`${n(unverified, "result was", "results were")} not confirmed by the independent re-run.`] : []),
          ...notes,
        ],
      };
    },
  };

  const EXECUTOR_TOOLS = ["read_test_file", "list_test_files", "get_api_reference", "list_rooms", "write_generated_test", "run_generated_test"];

  const review: Stage = {
    name: "review",
    title: "Reviewer: generated tests → checked against their cases",
    async run(ctx) {
      if (!ctx.exists("execution.json")) throw new Error("no execution.json in the run folder");
      const plan = await ctx.readJson<TestPlan>("test-plan.json");
      const reports = await ctx.readJson<ExecutionReport[]>("execution.json");
      const toReview = reports.filter((r) => r.file && r.outcome !== "blocked");
      if (toReview.length === 0) return { skipped: true, notes: ["No generated tests to review."] };

      const maxRounds = options.reviewRounds ?? 1;
      const reviews: Review[] = ctx.exists("reviews.json") ? await ctx.readJson<Review[]>("reviews.json") : [];
      const finished = (caseId: string) => reviews.some((r) => r.caseId === caseId && (r.verdict === "approve" || (r.round ?? 1) > maxRounds));

      // The Reviewer reads; it never writes. Revisions go back to the Executor, with the Executor's tools.
      const reviewer = modelForRole("reviewer", scriptedReviewer, env);
      const executor = modelForRole("executor", scriptedExecutorRevision, env);
      const readTools = await qaTools({ include: ["read_test_file", "list_requirements", "get_api_reference"] }, env);
      const writeTools = await qaTools({ include: EXECUTOR_TOOLS }, env, { QA_TOOLS_ALLOW_TEST_WRITES: "true" });
      let usage = NONE;
      let revised = 0;
      try {
        for (const original of toReview) {
          if (finished(original.caseId)) continue;
          const testCase = plan.cases.find((c) => c.id === original.caseId);
          if (!testCase) continue;
          let report = reports.find((r) => r.caseId === original.caseId)!;
          for (let round = 1; ; round++) {
            if (ctx.tokensLeft(usage.inputTokens + usage.outputTokens) <= 0) throw new Error("the run's token budget is spent");
            const source = await readFile(`tests/generated/${report.file}`, "utf8");
            if (options.verbose) console.log(`  --- review ${testCase.id}, round ${round}`);
            const { review, run } = await runReviewer({ model: reviewer, tools: readTools.tools, testCase, source, report, onEvent: events("    ") });
            usage = add(usage, run.usage);
            if (!review) throw new Error(`the Reviewer produced no review for ${testCase.id} (${run.status})`);
            reviews.push({ ...review, round });
            await ctx.write("reviews.json", reviews);
            if (review.verdict === "approve" || round > maxRounds) break;

            // The evaluator loop: the findings go back to the Executor for one more attempt.
            const result = await runExecutor({ model: executor, tools: writeTools.tools, testCase, revision: revisionRequest(review), onEvent: events("    ") });
            usage = add(usage, result.run.usage);
            if (!result.report) break;
            revised++;
            report = { ...result.report, notes: `${result.report.notes} (revised after review round ${round})`.trim() };
            reports[reports.findIndex((r) => r.caseId === testCase.id)] = report;
            await ctx.write("execution.json", reports);
          }
        }
      } finally {
        await readTools.close();
        await writeTools.close();
      }
      await ctx.write("reviews.md", renderReviews(reviews));
      const last = new Map(reviews.map((r) => [r.caseId, r]));
      const approved = [...last.values()].filter((r) => r.verdict === "approve").length;
      const open = last.size - approved;
      return {
        usage,
        artifacts: ["reviews.json", "reviews.md", "execution.json"],
        notes: [
          `${n(last.size, "test")} reviewed: ${approved} approved, ${n(revised, "revision")}, ${open} still disputed.`,
          `${reviewer.provider} / ${reviewer.model}`,
        ],
      };
    },
  };

  const triage: Stage = {
    name: "triage",
    title: "Triager: failures → classified, with draft bug reports",
    async run(ctx) {
      const reports = ctx.exists("execution.json") ? await ctx.readJson<ExecutionReport[]>("execution.json") : [];
      const plan = ctx.exists("test-plan.json") ? await ctx.readJson<TestPlan>("test-plan.json") : undefined;
      const failures = await failuresFromExecution(reports, plan);
      if (failures.length === 0) return { skipped: true, notes: ["No failures to triage."] };

      const model = modelForRole("triager", scriptedCrewTriager, env);
      const toolbox = await qaTools(
        { include: ["read_test_file", "list_requirements", "get_api_reference", "search_issues", "search_knowledge", "recent_changes"] },
        env,
      );
      let usage = NONE;
      const items: TriageItem[] = [];
      const artifacts = ["triage.json", "triage.md"];
      try {
        for (const failure of failures) {
          const pack = await collectEvidence(failure);
          const { item, run } = await runTriager({ model, tools: toolbox.tools, pack, onEvent: events("  ") });
          usage = add(usage, run.usage);
          if (item) items.push(item);
        }
      } finally {
        await toolbox.close();
      }
      await ctx.write("triage.json", items);
      await ctx.write("triage.md", renderTriage(items));
      for (const item of items) {
        const draft = renderBugReport(item);
        if (draft) artifacts.push(await ctx.write(`issues/DRAFT-${item.caseId ?? item.title.slice(0, 20)}.md`, draft));
      }
      const by = (c: TriageItem["classification"]) => items.filter((i) => i.classification === c).length;
      return {
        usage,
        artifacts,
        notes: [
          `${n(items.length, "failure")}: ${n(by("product-bug"), "product bug")} (${items.filter((i) => i.duplicateOf).length} already reported), ${n(by("test-bug"), "test bug")}, ${by("flaky")} flaky, ${by("environment")} environment, ${by("needs-human")} for a human.`,
        ],
      };
    },
  };

  return [analyze, design, execute, review, triage];
}
