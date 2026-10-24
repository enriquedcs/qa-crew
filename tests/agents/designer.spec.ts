import { test, expect } from "@playwright/test";
import { curateTestPlan, similarity, uncoveredRisks } from "../../src/agents/designer/curate.ts";
import { runDesigner } from "../../src/agents/designer/designer.ts";
import { techniquesPrompt } from "../../src/agents/designer/techniques.ts";
import { boundaryValues, daysFrom, testDataTools } from "../../src/agents/designer/testData.ts";
import type { Risk, TestCase } from "../../src/crew/contracts.ts";
import { createMockClient } from "../../src/llm/index.ts";

const risk = (id: string, score: number, level: Risk["level"]): Risk => ({
  id,
  title: id,
  requirementIds: [],
  category: "functional",
  impact: 1,
  likelihood: 1,
  rationale: "",
  evidence: [],
  score,
  level,
});

let n = 0;
const tc = (over: Partial<TestCase>): TestCase => ({
  id: `TC-${++n}`,
  title: `case number${n}`,
  riskIds: ["R1"],
  requirementIds: [],
  technique: "boundary-values",
  layer: "api",
  priority: "p2",
  preconditions: [],
  steps: ["s"],
  data: { n },
  expected: `e${n}`,
  ...over,
});

const risks = [risk("R1", 20, "high"), risk("R2", 9, "medium"), risk("R3", 4, "low")];

test.describe("test data", () => {
  test("boundary values sit on and just outside each limit", () => {
    expect(boundaryValues(1, 2)).toEqual([
      { value: 0, valid: false },
      { value: 1, valid: true },
      { value: 2, valid: true },
      { value: 3, valid: false },
    ]);
  });

  test("relative dates cross months and years correctly", () => {
    const base = new Date("2026-12-31T22:00:00Z");
    expect(daysFrom(base, 1)).toBe("2027-01-01");
    expect(daysFrom(base, -31)).toBe("2026-11-30");
  });

  test("the relative_dates tool uses the clock it is given", async () => {
    const tool = testDataTools(() => new Date("2028-02-28T00:00:00Z")).find((t) => t.name === "relative_dates");
    expect(await tool?.run({ offsets: [1, 2] })).toEqual([
      { offset: 1, date: "2028-02-29" },
      { offset: 2, date: "2028-03-01" },
    ]);
  });
});

test.describe("curation", () => {
  test("drops cases that trace to no known risk", () => {
    const plan = curateTestPlan({ feature: "f", cases: [tc({ riskIds: ["R9"] })] }, risks);
    expect(plan.cases).toEqual([]);
    expect(plan.dropped?.[0].reason).toContain("traces to no risk");
  });

  test("drops exact duplicates and near-identical titles, keeping the higher priority", () => {
    const keep = tc({ title: "The API rejects 3 guests for a double room", priority: "p1", data: { guests: 3 }, expected: "400" });
    const sameSignature = tc({ title: "Totally different words", priority: "p2", data: { guests: 3 }, expected: "400" });
    const sameTitle = tc({ title: "The API rejects 3 guests for a double room!", priority: "p3" });
    const plan = curateTestPlan({ feature: "f", cases: [sameSignature, sameTitle, keep] }, risks);
    expect(plan.cases.map((c) => c.id)).toEqual([keep.id]);
    expect(plan.dropped?.map((d) => d.reason)).toEqual([`duplicate of ${keep.id}`, `duplicate of ${keep.id}`]);
  });

  test("keeps a budget per risk level and ranks the riskiest first", () => {
    const cases = [
      ...Array.from({ length: 3 }, () => tc({ riskIds: ["R3"] })),
      ...Array.from({ length: 6 }, () => tc({ riskIds: ["R1"] })),
      ...Array.from({ length: 3 }, () => tc({ riskIds: ["R2"] })),
    ];
    const plan = curateTestPlan({ feature: "f", cases }, risks);
    expect(plan.cases.map((c) => c.riskIds[0])).toEqual(["R1", "R1", "R1", "R1", "R2", "R2", "R3"]);
    expect(plan.dropped).toHaveLength(5);
  });

  test("reports risks that ended up with no test", () => {
    const plan = curateTestPlan({ feature: "f", cases: [tc({ riskIds: ["R1"] })] }, risks);
    expect(uncoveredRisks(plan, risks).map((r) => r.id)).toEqual(["R2", "R3"]);
  });

  test("title similarity ignores punctuation and short words", () => {
    expect(similarity("Rejects 3 guests in r2", "rejects 3 GUESTS in r2!")).toBe(1);
    expect(similarity("Rejects past check-in", "Accepts back-to-back stays")).toBe(0);
  });
});

test("techniques become prompt instructions", () => {
  const prompt = techniquesPrompt(["boundary-values"]);
  expect(prompt).toContain("boundary-values (use when");
  expect(prompt).not.toContain("pairwise");
});

test("the Designer only sees the accepted risks it is given, and its plan is curated", async () => {
  const model = createMockClient([
    { toolCalls: [{ name: "boundary_values", input: { min: 1, max: 2 } }] },
    { toolCalls: [{ name: "submit_result", input: { feature: "f", cases: [tc({ riskIds: ["R1"] }), tc({ riskIds: ["R7"] })] } }] },
  ]);
  const { plan, uncovered } = await runDesigner({ model, tools: testDataTools(), feature: "f", risks: [risks[0], risks[1]] });

  expect(model.requests[0].messages[0]).toMatchObject({ role: "user" });
  const task = model.requests[0].messages[0];
  expect("content" in task ? task.content : "").not.toContain('"R3"');
  expect(plan?.cases).toHaveLength(1);
  expect(plan?.dropped?.[0].reason).toContain("traces to no risk");
  expect(uncovered.map((r) => r.id)).toEqual(["R2"]);
});
