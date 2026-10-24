// Chapter 5: the Analyst turns requirements into a risk map.
//
//   npm run app                                   # in one terminal
//   npm run ch05                                  # in another (uses QA_MODEL_* from .env)
//   QA_MODEL_PROVIDER=mock npm run ch05           # no API key: a scripted model, real tools
//   npm run ch05 -- max-stay-limit                # analyze another requirements document
//
// Output, for a human to review:
//   out/analyst/<feature>.risk-map.md     the readable version
//   out/analyst/<feature>.risk-map.json   the version you edit (status, scores) and the Designer reads

import type { MockTurn } from "../llm/index.ts";
import { connectMcpServers, loadMcpConfig } from "../mcp/connect.ts";
import { runAnalyst } from "../agents/analyst/analyst.ts";
import { renderRiskMap } from "../agents/analyst/render.ts";
import { loadEnv, modelOrMock, printEvents, writeArtifact } from "../agents/shared.ts";

loadEnv();
const feature = process.argv[2] ?? "booking-rules";

function scriptedAnalyst(): MockTurn[] {
  return [
    { text: "Start with the requirements, the API and the rooms.", toolCalls: [{ name: "list_requirements", input: { key: feature } }, { name: "get_api_reference", input: {} }, { name: "list_rooms", input: {} }] },
    { text: "What do the existing tests already cover?", toolCalls: [{ name: "trace_requirements", input: {} }, { name: "read_test_file", input: { path: "spec/booking-rules.spec.ts" } }] },
    { text: "Has the team been bitten in these areas before?", toolCalls: [{ name: "search_knowledge", input: { query: "double booking concurrent" } }, { name: "search_knowledge", input: { query: "check-in today time zone" } }, { name: "search_knowledge", input: { query: "rule enforced only in UI not API" } }, { name: "search_knowledge", input: { query: "cancel booking" } }] },
    {
      toolCalls: [
        {
          name: "submit_result",
          input: {
            feature,
            summary: "Risk concentrates where a rule is enforced in only one layer (capacity), where a rule depends on an undefined 'today' (past check-in), and where the overlap rule meets concurrency. Cancellation has no ownership rule at all.",
            risks: [
              { id: "R1", title: "The API books more guests than a room fits", requirementIds: ["booking-rules:FR-005"], category: "functional", impact: 4, likelihood: 5, rationale: "Any client that calls the API directly can overbook. It is already happening: the acceptance check is an expected failure.", evidence: ["FR-005: capacity must be enforced in the UI and in the API.", "tests/spec/booking-rules.spec.ts marks the FR-005 check with test.fail().", "BUG-0019: a rule enforced only in the browser was abused through the API."] },
              { id: "R2", title: "Stays that start in the past are accepted, and 'today' is undefined", requirementIds: ["booking-rules:FR-007"], category: "functional", impact: 4, likelihood: 4, rationale: "The API does not check the date today, and when it does, the time zone question decides who gets rejected.", evidence: ["FR-007 is marked NEEDS CLARIFICATION on the time zone.", "BUG-0007: 'today' in UTC rejected guests in Tokyo."] },
              { id: "R3", title: "Two simultaneous requests double-book a room", requirementIds: ["booking-rules:FR-008"], category: "data", impact: 5, likelihood: 2, rationale: "The overlap test books sequentially; it cannot catch a race. The impact is the worst in the product.", evidence: ["FR-008: a room must not have overlapping stays.", "BUG-0012: concurrent requests passed the availability check together."] },
              { id: "R4", title: "Off-by-one errors around check-out day", requirementIds: ["booking-rules:FR-008", "booking-rules:FR-009"], category: "functional", impact: 4, likelihood: 2, rationale: "Inclusive/exclusive date logic is a classic source of bugs; one boundary is tested, the other side is not.", evidence: ["FR-009 allows a stay to start on another stay's check-out day.", "Only one back-to-back case exists in the spec tests."] },
              { id: "R5", title: "Anyone with a booking id can cancel someone else's booking", requirementIds: ["booking-rules:FR-010"], category: "security", impact: 4, likelihood: 3, rationale: "Ids are short and sequential, and there is no ownership check.", evidence: ["Assumption in the spec: 'whoever has a booking id can cancel it'.", "BUG-0023: a reused id led to cancelling the wrong booking."] },
              { id: "R6", title: "Very long or unusual guest names break the bookings table", requirementIds: ["booking-rules:FR-011"], category: "usability", impact: 2, likelihood: 2, rationale: "Names are only checked for blank; there is no length limit.", evidence: ["FR-003 only requires a non-blank name."] },
            ],
            questions: [
              { requirementId: "booking-rules:FR-007", question: "Whose 'today' counts: the hotel's, the guest's or UTC?", whyItMatters: "It decides which bookings around midnight are valid; BUG-0007 came from this." },
              { requirementId: "booking-rules:FR-010", question: "Should cancellation require proof of ownership?", whyItMatters: "Without it, R5 is a feature, not a bug, and nobody will test for it." },
            ],
            missingRequirements: [
              { title: "Behavior under concurrent booking requests", why: "FR-008 says what must be true, not that it must stay true when two requests race." },
              { title: "A maximum length for a stay", why: "Nothing limits a booking to a sensible number of nights; see odd/tasks/max-stay-limit.md." },
            ],
          },
        },
      ],
    },
  ];
}

const model = modelOrMock(scriptedAnalyst);
const servers = await loadMcpConfig(".mcp.json");
const toolbox = await connectMcpServers([{ name: "qa-tools", config: servers["qa-tools"], filter: { readOnly: true } }]);

try {
  console.log(`Analyst on "${feature}" using ${model.provider} / ${model.model}\n`);
  const { run, riskMap } = await runAnalyst({ model, tools: toolbox.tools, feature, onEvent: printEvents() });

  console.log(`\nStatus: ${run.status} after ${run.steps} steps (${run.usage.inputTokens} in / ${run.usage.outputTokens} out tokens)`);
  if (!riskMap) process.exit(1);

  const base = `out/analyst/${feature}.risk-map`;
  await writeArtifact(`${base}.json`, riskMap);
  await writeArtifact(`${base}.md`, renderRiskMap(riskMap));

  console.log(`\n${riskMap.summary}\n`);
  for (const r of riskMap.risks) {
    console.log(`  ${(r.level ?? "").toUpperCase().padEnd(6)} ${String(r.score).padStart(2)}  ${r.id} ${r.title}`);
    for (const w of r.warnings ?? []) console.log(`              ⚠ ${w}`);
  }
  console.log(`\n${riskMap.questions.length} open questions, ${riskMap.missingRequirements.length} possibly missing requirements.`);
  console.log(`Review: ${base}.md   Edit: ${base}.json`);
} finally {
  await toolbox.close();
}
