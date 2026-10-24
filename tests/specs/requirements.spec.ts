import { test, expect } from "@playwright/test";
import { loadRequirements, parseOddFeature, parseSpecKitSpec } from "../../src/specs/requirements.ts";
import { buildTraceReport, findRequirementTags } from "../../src/specs/trace.ts";

// The parsers that turn SDD specs and ODD feature documents into one list of
// requirements, and the trace that checks them against the tests.

test("parses Spec Kit requirements, scenarios and clarifications", () => {
  const doc = parseSpecKitSpec(
    [
      "# Feature Specification: Login",
      "1. **Given** a user, **When** they log in, **Then** they see the home page. *(FR-001)*",
      "- **FR-001**: Users MUST be able to log in.",
      "- **FR-002**: Sessions MUST expire after [NEEDS CLARIFICATION: how long?].",
    ].join("\n"),
    "login",
  );
  expect(doc.title).toBe("Login");
  expect(doc.requirements.map((r) => r.id)).toEqual(["login:FR-001", "login:FR-002"]);
  expect(doc.requirements[0].checks).toEqual(["Given a user, When they log in, Then they see the home page."]);
  expect(doc.openQuestions).toEqual(["how long?"]);
});

test("parses ODD specs, oracles and open questions from the log", () => {
  const doc = parseOddFeature(
    [
      "# dark-mode: add a dark theme",
      "## Specs",
      "- S1 Toggle: a switch changes the theme. Oracle: the body has class dark. Risk: contrast.",
      "- S2 Persist: the choice survives a reload.",
      "## Tasks",
      "- [ ] T1 S1 RED test",
      "## Log",
      "- L1 user (verbatim): > Add dark mode",
      "- L2 open question for design: which palette?",
    ].join("\n"),
    "dark-mode",
  );
  expect(doc.title).toBe("add a dark theme");
  expect(doc.requirements.map((r) => r.localId)).toEqual(["S1", "S2"]);
  expect(doc.requirements[0].checks).toEqual(["the body has class dark."]);
  expect(doc.requirements[1].checks).toEqual([]);
  expect(doc.openQuestions).toEqual(["which palette?"]);
});

test("loads the project's own specs and ODD documents", async () => {
  const docs = await loadRequirements(".");
  const rules = docs.find((d) => d.key === "booking-rules");
  expect(rules?.workflow).toBe("sdd");
  expect(rules?.requirements).toHaveLength(10);
  expect(rules?.requirements.find((r) => r.localId === "FR-005")?.checks[0]).toContain("capacity of 1");
  expect(docs.find((d) => d.key === "max-stay-limit")?.requirements).toHaveLength(4);
});

test("every booking rule has an acceptance test, and no tag points nowhere", async () => {
  const report = buildTraceReport(await loadRequirements("."), await findRequirementTags("tests"));
  expect(report.uncovered.filter((r) => r.id.startsWith("booking-rules:"))).toEqual([]);
  expect(report.unknownTags).toEqual([]);
});

test("a tag for a requirement that does not exist is reported as drift", () => {
  const report = buildTraceReport(
    [{ key: "x", title: "x", workflow: "sdd", file: "x", openQuestions: [], requirements: [{ id: "x:FR-001", localId: "FR-001", text: "t", checks: [] }] }],
    [{ tag: "x:FR-002", file: "tests/a.spec.ts", line: 3 }],
  );
  expect(report.uncovered.map((r) => r.id)).toEqual(["x:FR-001"]);
  expect(report.unknownTags.map((u) => u.tag)).toEqual(["x:FR-002"]);
});
