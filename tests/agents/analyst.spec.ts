import { test, expect } from "@playwright/test";
import { runAnalyst } from "../../src/agents/analyst/analyst.ts";
import { curateRiskMap, risksForDesign, scoreRisk } from "../../src/agents/analyst/curate.ts";
import { renderRiskMap } from "../../src/agents/analyst/render.ts";
import type { RiskMap } from "../../src/crew/contracts.ts";
import { searchKnowledge } from "../../src/knowledge/search.ts";
import { createMockClient } from "../../src/llm/index.ts";
import { connectMcpServers, loadMcpConfig } from "../../src/mcp/connect.ts";

const APP_URL = `http://localhost:${process.env.APP_PORT ?? 3100}`;

const baseRisk = {
  title: "t",
  category: "functional" as const,
  rationale: "r",
  evidence: ["e"],
};

const map = (risks: RiskMap["risks"]): RiskMap => ({
  feature: "booking-rules",
  summary: "s",
  risks,
  questions: [],
  missingRequirements: [],
});

test.describe("risk scoring and grounding", () => {
  test("impact × likelihood decides the level", () => {
    expect(scoreRisk(5, 3)).toEqual({ score: 15, level: "high" });
    expect(scoreRisk(4, 2)).toEqual({ score: 8, level: "medium" });
    expect(scoreRisk(2, 3)).toEqual({ score: 6, level: "low" });
  });

  test("sorts by score and marks every risk as proposed", () => {
    const curated = curateRiskMap(
      map([
        { ...baseRisk, id: "R1", requirementIds: ["x:FR-001"], impact: 2, likelihood: 2 },
        { ...baseRisk, id: "R2", requirementIds: ["x:FR-001"], impact: 5, likelihood: 4 },
      ]),
      ["x:FR-001"],
    );
    expect(curated.risks.map((r) => [r.id, r.score, r.level, r.status])).toEqual([
      ["R2", 20, "high", "proposed"],
      ["R1", 4, "low", "proposed"],
    ]);
  });

  test("flags requirement ids the model invented", () => {
    const curated = curateRiskMap(
      map([{ ...baseRisk, id: "R1", requirementIds: ["x:FR-001", "x:FR-099"], impact: 3, likelihood: 3 }]),
      ["x:FR-001"],
    );
    expect(curated.risks[0].warnings?.[0]).toContain("x:FR-099");
  });

  test("a human decision survives curation, and rejected risks never reach the Designer", () => {
    const curated = curateRiskMap(
      map([
        { ...baseRisk, id: "R1", requirementIds: [], impact: 3, likelihood: 3, status: "rejected" },
        { ...baseRisk, id: "R2", requirementIds: [], impact: 3, likelihood: 3, status: "accepted" },
        { ...baseRisk, id: "R3", requirementIds: [], impact: 3, likelihood: 3 },
      ]),
      [],
    );
    expect(risksForDesign(curated).map((r) => r.id)).toEqual(["R2", "R3"]);
    expect(risksForDesign(curated, { requireReview: true }).map((r) => r.id)).toEqual(["R2"]);
  });

  test("renders a reviewable Markdown table", () => {
    const md = renderRiskMap(curateRiskMap(map([{ ...baseRisk, id: "R1", requirementIds: ["x:FR-001"], impact: 4, likelihood: 4 }]), ["x:FR-001"]));
    expect(md).toContain("| HIGH | **R1** t | 4 × 4 = 16 | x:FR-001 | proposed |");
    expect(md).toContain("## How to review");
  });
});

test.describe("team knowledge search", () => {
  test("finds the past bug that matches the risk", async () => {
    const [best] = await searchKnowledge("knowledge", "two requests double booked the same room");
    expect(best.file).toBe("bugs/BUG-0012-concurrent-double-booking.md");
  });

  test("rare words outweigh common ones", async () => {
    const [best] = await searchKnowledge("knowledge", "booking time zone");
    expect(best.file).toBe("bugs/BUG-0007-checkin-timezone.md");
  });

  test("returns nothing rather than noise", async () => {
    expect(await searchKnowledge("knowledge", "kubernetes")).toEqual([]);
  });
});

test("the Analyst runs end to end through MCP with a scripted model", async () => {
  const servers = await loadMcpConfig(".mcp.json", { ...process.env, BOOKING_URL: APP_URL });
  const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"], filter: { readOnly: true } }]);
  try {
    const model = createMockClient([
      { toolCalls: [{ name: "list_requirements", input: { key: "booking-rules" } }, { name: "search_knowledge", input: { query: "concurrent double booking" } }] },
      {
        toolCalls: [
          {
            name: "submit_result",
            input: {
              feature: "booking-rules",
              summary: "s",
              risks: [
                { ...baseRisk, id: "R1", requirementIds: ["booking-rules:FR-008"], impact: 5, likelihood: 2 },
                { ...baseRisk, id: "R2", requirementIds: ["booking-rules:FR-005"], impact: 4, likelihood: 5 },
                { ...baseRisk, id: "R3", requirementIds: ["booking-rules:FR-042"], impact: 1, likelihood: 1 },
              ],
              questions: [],
              missingRequirements: [],
            },
          },
        ],
      },
    ]);

    const { riskMap, run } = await runAnalyst({ model, tools: toolbox.tools, feature: "booking-rules" });

    expect(run.status).toBe("done");
    // The model saw the real past bug through the MCP tool...
    const knowledge = model.requests[1].messages.find((m) => m.role === "tool" && m.name === "search_knowledge");
    expect(knowledge && "content" in knowledge ? knowledge.content : "").toContain("BUG-0012");
    // ...and code, not the model, decided the order and caught the invented id.
    expect(riskMap?.risks.map((r) => r.id)).toEqual(["R2", "R1", "R3"]);
    expect(riskMap?.risks[2].warnings?.[0]).toContain("FR-042");
  } finally {
    await toolbox.close();
  }
});
