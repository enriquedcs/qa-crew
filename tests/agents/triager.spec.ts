import { test, expect } from "@playwright/test";
import { collectEvidence, failuresFrom, signatureOf } from "../../src/agents/triager/evidence.ts";
import { applyGuards } from "../../src/agents/triager/guards.ts";
import { knownIssueIds, renderBugReport, runTriager } from "../../src/agents/triager/triager.ts";
import type { EvidencePack, TriageItem } from "../../src/crew/contracts.ts";
import { createMockClient } from "../../src/llm/index.ts";
import { connectMcpServers, loadMcpConfig } from "../../src/mcp/connect.ts";
import { runPlaywright } from "../../src/runner/playwright.ts";

const STATUS_ERROR = "Error: expect(received).toBe(expected)\n\nExpected: 400\nReceived: 201";
const TIMEOUT_ERROR = "TimeoutError: locator.click: Timeout 3000ms exceeded.";

const pack = (runs: EvidencePack["runs"], error = STATUS_ERROR, appHealthy = true): EvidencePack => ({
  failure: { file: "tests/x.spec.ts", title: "t", error },
  runs,
  consistent: runs.every((r) => r.status === "failed"),
  appHealthy,
  testSource: "",
});

const item = (over: Partial<TriageItem>): TriageItem => ({
  file: "tests/x.spec.ts",
  title: "t",
  classification: "product-bug",
  confidence: "high",
  rationale: "r",
  evidence: ["e"],
  ...over,
});

const report = {
  title: "Bookings can be made in the past",
  severity: "high" as const,
  summary: "s",
  stepsToReproduce: ["POST /api/bookings with yesterday"],
  expected: "400 (booking-rules:FR-007)",
  actual: "201",
  requirementIds: ["booking-rules:FR-007"],
  suspectedArea: "src/app/validation.ts",
};

const failed = { status: "failed", error: STATUS_ERROR };
const issues = new Set(["ISSUE-0031"]);

test.describe("guards", () => {
  test("a consistent failure cannot be flaky", () => {
    const out = applyGuards(item({ classification: "flaky" }), pack([failed, failed, failed]), issues);
    expect(out.classification).toBe("needs-human");
    expect(out.warnings?.[0]).toContain("not flaky");
  });

  test("calling a wrong status a test bug needs a human", () => {
    const out = applyGuards(item({ classification: "test-bug", testFix: { summary: "s", change: "c" } }), pack([failed, failed, failed]), issues);
    expect(out.classification).toBe("needs-human");
    expect(out.warnings?.[0]).toContain("expected 400, received 201");
  });

  test("a locator timeout can be a test bug", () => {
    const timeout = { status: "failed", error: TIMEOUT_ERROR };
    const out = applyGuards(item({ classification: "test-bug" }), pack([timeout, timeout, timeout], TIMEOUT_ERROR), issues);
    expect(out).toMatchObject({ classification: "test-bug" });
    expect(out.warnings).toBeUndefined();
  });

  test("an intermittent product bug is allowed, with a warning", () => {
    const out = applyGuards(item({ bugReport: report }), pack([failed, { status: "passed" }, failed]), issues);
    expect(out.classification).toBe("product-bug");
    expect(out.warnings?.[0]).toContain("1 of 3 runs passed");
  });

  test("duplicates must point at a real issue", () => {
    const out = applyGuards(item({ duplicateOf: "ISSUE-9999" }), pack([failed, failed]), issues);
    expect(out.duplicateOf).toBeUndefined();
    expect(out.classification).toBe("needs-human"); // and then it is a new product bug with no report
  });

  test("an unhealthy environment is called out", () => {
    const down = { status: "failed", error: "Error: connect ECONNREFUSED 127.0.0.1:3200" };
    const out = applyGuards(item({ bugReport: report }), pack([down, down], down.error, false), issues);
    expect(out.warnings?.join(" ")).toContain("environment problem");
  });
});

test.describe("evidence", () => {
  test("error signatures ignore timings", () => {
    expect(signatureOf("TimeoutError: locator.click: Timeout 3000ms exceeded.")).toBe(signatureOf("TimeoutError: locator.click: Timeout 2999ms exceeded."));
    expect(signatureOf(STATUS_ERROR)).toBe("Expected: 400, Received: 201");
  });

  test("failures come from failed tests only", () => {
    const failures = failuresFrom({
      file: "f",
      passed: 1,
      failed: 1,
      tests: [
        { title: "a", status: "passed", durationMs: 1 },
        { title: "b", status: "failed", durationMs: 1, error: "boom" },
      ],
    });
    expect(failures).toEqual([{ file: "f", title: "b", error: "boom" }]);
  });

  test("the issue tracker ids are read from file names", async () => {
    expect([...(await knownIssueIds("issues"))].sort()).toEqual(["ISSUE-0027", "ISSUE-0031"]);
  });

  test("a bug report is rendered for a developer", () => {
    const md = renderBugReport(item({ bugReport: report, caseId: "TC-05" })) ?? "";
    expect(md).toContain("# Bookings can be made in the past");
    expect(md).toContain("1. POST /api/bookings with yesterday");
    expect(md).toContain("Review before filing");
  });
});

test("the Triager links a known product bug to its issue, end to end", async () => {
  test.setTimeout(120_000);
  const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;
  const [failure] = failuresFrom(await runPlaywright("tests/triage-demo/capacity.spec.ts", { appPort: 3203 }));
  expect(failure.error).toContain("Expected: 400");

  const evidence = await collectEvidence(failure, { reruns: 1, appPort: 3203 });
  expect(evidence.runs.map((r) => r.status)).toEqual(["failed", "failed"]);
  expect(evidence.consistent).toBe(true);

  const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
  const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"], filter: { include: ["search_issues"] } }]);
  try {
    const model = createMockClient([
      { toolCalls: [{ name: "search_issues", input: { query: "API capacity guests" } }] },
      { toolCalls: [{ name: "submit_result", input: { classification: "product-bug", confidence: "high", rationale: "r", evidence: ["e"], duplicateOf: "ISSUE-0031" } }] },
    ]);
    const { item: triaged } = await runTriager({ model, tools: toolbox.tools, pack: evidence });

    const found = model.requests[1].messages.find((m) => m.role === "tool");
    expect(found && "content" in found ? found.content : "").toContain("ISSUE-0031");
    expect(triaged).toMatchObject({ classification: "product-bug", duplicateOf: "ISSUE-0031", file: "tests/triage-demo/capacity.spec.ts" });
    expect(triaged?.warnings).toBeUndefined();
  } finally {
    await toolbox.close();
  }
});
