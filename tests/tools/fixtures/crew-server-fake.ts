// A qa-crew MCP server with fake stages, for tests: same tools, gates and approvals, no models.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Stage } from "../../../src/crew/orchestrator.ts";
import { createCrewServer } from "../../../src/tools/crew/createServer.ts";

const stage = (name: string, files: Record<string, unknown> = {}, review?: string): Stage => ({
  name,
  title: name,
  async run(ctx) {
    for (const [file, content] of Object.entries(files)) await ctx.write(file, content as object);
    return { usage: { inputTokens: 100, outputTokens: 10 }, artifacts: Object.keys(files), review, notes: [`${name} ok`] };
  },
});

const bug = {
  file: "tests/generated/tc-05-past-checkin.spec.ts", title: "TC-05", caseId: "TC-05", classification: "product-bug", confidence: "high",
  rationale: "r", evidence: ["Expected 400, Received 201."],
  bugReport: { title: "Bookings can be made for stays that have already started", severity: "high", summary: "s", stepsToReproduce: ["POST /api/bookings with yesterday"], expected: "400 (booking-rules:FR-007)", actual: "201", requirementIds: ["booking-rules:FR-007"], suspectedArea: "src/app/validation.ts" },
};
const dup = { ...bug, caseId: "TC-02", title: "TC-02", bugReport: undefined, duplicateOf: "ISSUE-0031" };

const stages = () => [
  stage("analyze", { "risk-map.json": { risks: [] }, "risk-map.md": "# Risk map\n\nR1 capacity" }, "risk-map.json"),
  stage("design", { "test-plan.json": { cases: [] }, "test-plan.md": "# Test plan" }, "test-plan.json"),
  stage("execute"),
  stage("review"),
  stage("triage", { "triage.json": [dup, bug] }),
];

serveStdio(() =>
  createCrewServer({
    store: { root: process.env.QA_CREW_RUNS! },
    issuesDir: process.env.QA_CREW_ISSUES!,
    stages,
    reviewer: "enrique",
    background: false,
  }),
);
