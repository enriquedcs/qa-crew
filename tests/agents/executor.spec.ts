import { test, expect } from "@playwright/test";
import { rm } from "node:fs/promises";
import { errorHeadline, reconcile, runExecutor } from "../../src/agents/executor/executor.ts";
import { checkGeneratedTest } from "../../src/agents/executor/gates.ts";
import type { ExecutionReport, TestCase } from "../../src/crew/contracts.ts";
import { createMockClient } from "../../src/llm/index.ts";
import { connectMcpServers, loadMcpConfig, type McpToolbox } from "../../src/mcp/connect.ts";

const GOOD = `import { test, expect } from "../support/fixtures.ts";

test("TC-01 a double room accepts 2 guests", { tag: ["@TC-01", "@booking-rules:FR-005"] }, async ({ bookingApi }) => {
  const res = await bookingApi.create({ roomId: "r2", guests: 2 });
  expect(res.status()).toBe(201);
});
`;

test.describe("quality gates", () => {
  test("a well-formed test passes", () => {
    expect(checkGeneratedTest(GOOD, { caseId: "TC-01" })).toEqual({ errors: [], warnings: [] });
  });

  for (const [name, code, message] of [
    ["skipped tests", GOOD.replace("test(", "test.skip("), "Do not skip"],
    ["expected failures", GOOD.replace("expect(res", "test.fail();\n  expect(res"), "Only a human"],
    ["sleeps", GOOD.replace("expect(res", "await page.waitForTimeout(500);\n  expect(res"), "Do not sleep"],
    ["fixed dates", GOOD.replace('guests: 2 }', 'guests: 2, checkIn: "2030-05-01" }'), "hard-code dates"],
    ["no assertions", GOOD.replace("expect(res.status()).toBe(201);", "res.status();"), "no assertions"],
    ["assertions that cannot fail", GOOD.replace("expect(res.status()).toBe(201)", "expect(true).toBe(true)"), "cannot fail"],
    ["foreign imports", `import fs from "node:fs";\n${GOOD}`, "Only import"],
    ["a missing case tag", GOOD.replace('"@TC-01", ', ""), "case id"],
    ["a missing requirement tag", GOOD.replace(', "@booking-rules:FR-005"', ""), "requirement"],
  ] as const) {
    test(`reject ${name}`, () => {
      expect(checkGeneratedTest(code, { caseId: "TC-01" }).errors.join(" ")).toContain(message);
    });
  }

  test("warn about brittle selectors without blocking", () => {
    const result = checkGeneratedTest(GOOD.replace("expect(res", 'await page.locator(".btn").click();\n  expect(res'), { caseId: "TC-01" });
    expect(result.errors).toEqual([]);
    expect(result.warnings[0]).toContain("CSS selectors");
  });
});

test.describe("trust but verify", () => {
  const report = (outcome: ExecutionReport["outcome"]): ExecutionReport => ({
    caseId: "TC-01", file: "x.spec.ts", outcome, attempts: 1, evidence: "", notes: "",
  });
  const passed = { file: "x", passed: 1, failed: 0, tests: [{ title: "t", status: "passed" as const, durationMs: 1 }] };
  const failed = { file: "x", passed: 0, failed: 1, tests: [{ title: "t", status: "failed" as const, durationMs: 1, error: "Error: boom\nExpected: 400\nReceived: 201" }] };

  test("agrees when the re-run matches the claim", () => {
    expect(reconcile(report("passed"), passed).verified).toBe(true);
    expect(reconcile(report("failing-suspected-product-bug"), failed)).toEqual({
      verified: true,
      verification: "Re-run failed the same way: Expected: 400, Received: 201",
    });
  });

  test("disagrees when the agent claims a pass that did not happen", () => {
    expect(reconcile(report("passed"), failed).verified).toBe(false);
  });

  test("flags a failure that does not reproduce", () => {
    expect(reconcile(report("failing-suspected-product-bug"), passed).verification).toContain("flaky");
  });

  test("error headlines keep expected and received", () => {
    expect(errorHeadline("Error: x\n  Expected: 1\n  Received: 2\n  at foo")).toBe("Expected: 1, Received: 2");
  });
});

test.describe("the Executor end to end", () => {
  test.setTimeout(180_000);
  const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;
  let toolbox: McpToolbox;

  test.beforeAll(async () => {
    const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
    const config = servers["qa-tools"];
    toolbox = await connectMcpServers([
      { name: "qa-tools", config: { ...config, env: { ...config.env, QA_TOOLS_ALLOW_TEST_WRITES: "true", QA_TOOLS_RUNNER_PORT: "3201" } } },
    ]);
  });
  test.afterAll(async () => {
    await toolbox?.close();
    await rm("tests/generated/zz-executor-check.spec.ts", { force: true });
  });

  test("the write tool refuses to leave tests/generated/", async () => {
    const write = toolbox.tools.find((t) => t.name === "write_generated_test");
    await expect(write!.run({ file: "../baseline/api.spec.ts", content: GOOD })).rejects.toThrow(/not a valid file name/);
  });

  test("gates reject a bad test, the fixed test runs, and an independent re-run confirms the product bug", async () => {
    const testCase: TestCase = {
      id: "TC-02", title: "The API rejects 3 guests for a room of capacity 2", riskIds: ["R1"], requirementIds: ["booking-rules:FR-005"],
      technique: "boundary-values", layer: "api", priority: "p1", preconditions: [], steps: [], data: { roomId: "r2", guests: 3 },
      expected: "400 Bad Request and no booking is stored",
    };
    const bad = GOOD.replace("TC-01", "TC-02").replace("@TC-01", "@TC-02");
    const good = `import { test, expect } from "../support/fixtures.ts";

test("TC-02 capacity", { tag: ["@TC-02", "@booking-rules:FR-005"] }, async ({ bookingApi }) => {
  const res = await bookingApi.create({ roomId: "r2", guests: 3 });
  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);
});
`;
    const model = createMockClient([
      { toolCalls: [{ name: "write_generated_test", input: { file: "zz-executor-check.spec.ts", caseId: "TC-02", content: bad.replace("expect(res.status()).toBe(201);", "") } }] },
      { toolCalls: [{ name: "write_generated_test", input: { file: "zz-executor-check.spec.ts", caseId: "TC-02", content: good } }] },
      { toolCalls: [{ name: "run_generated_test", input: { file: "zz-executor-check.spec.ts" } }] },
      { toolCalls: [{ name: "submit_result", input: { caseId: "TC-02", file: "zz-executor-check.spec.ts", outcome: "failing-suspected-product-bug", attempts: 1, evidence: "Expected 400, received 201", notes: "" } }] },
    ]);

    const { report, run } = await runExecutor({ model, tools: toolbox.tools, testCase, runnerAppPort: 3202 });

    const toolResults = run.transcript.filter((m) => m.role === "tool");
    expect(toolResults[0]).toMatchObject({ isError: true }); // the gates stopped the test with no assertions
    expect(toolResults[2] && "content" in toolResults[2] ? toolResults[2].content : "").toContain('"failed": 1');
    expect(report).toMatchObject({ outcome: "failing-suspected-product-bug", verified: true });
    expect(report?.verification).toContain("Expected: 400");
  });
});
