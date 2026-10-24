import type { JsonSchema } from "../llm/types.ts";

// The hand-off contracts between QA Crew's agents.
// Each agent returns data in one of these shapes, and the next agent reads it.
// Keeping them in one file makes the crew's "API" easy to review.

// ---------------------------------------------------------------------------
// Analyst -> Designer: the risk map
// ---------------------------------------------------------------------------

export const RISK_CATEGORIES = ["functional", "data", "security", "usability", "performance", "integration"] as const;

/** A human decides. The Analyst proposes; only accepted risks reach the Designer. */
export type ReviewStatus = "proposed" | "accepted" | "rejected";

export interface Risk {
  id: string; // R1, R2...
  title: string;
  requirementIds: string[]; // e.g. booking-rules:FR-005; empty when the risk comes from a gap
  category: (typeof RISK_CATEGORIES)[number];
  /** 1 (negligible) .. 5 (severe): how bad is it if this goes wrong? */
  impact: number;
  /** 1 (rare) .. 5 (almost certain): how likely is it to go wrong? */
  likelihood: number;
  rationale: string;
  /** Facts the agent gathered with its tools: requirement text, past bugs, code it read. */
  evidence: string[];
  // Filled in by code, not by the model:
  score?: number;
  level?: "high" | "medium" | "low";
  status?: ReviewStatus;
  /** Set when the risk cites requirement ids that do not exist. */
  warnings?: string[];
}

export interface OpenQuestion {
  requirementId?: string;
  question: string;
  whyItMatters: string;
}

export interface MissingRequirement {
  title: string;
  why: string;
}

export interface RiskMap {
  feature: string;
  summary: string;
  risks: Risk[];
  questions: OpenQuestion[];
  missingRequirements: MissingRequirement[];
}

export const riskMapSchema: JsonSchema = {
  type: "object",
  properties: {
    feature: { type: "string", description: "The requirements document key, for example booking-rules." },
    summary: { type: "string", description: "Two or three sentences on where the risk concentrates." },
    risks: {
      type: "array",
      minItems: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "R1, R2, ..." },
          title: { type: "string", description: "What could go wrong, as a short sentence." },
          requirementIds: { type: "array", items: { type: "string" }, description: "Ids from list_requirements." },
          category: { type: "string", enum: [...RISK_CATEGORIES] },
          impact: { type: "integer", minimum: 1, maximum: 5 },
          likelihood: { type: "integer", minimum: 1, maximum: 5 },
          rationale: { type: "string", description: "Why this impact and likelihood." },
          evidence: { type: "array", minItems: 1, items: { type: "string" }, description: "Facts from your tools." },
        },
        required: ["id", "title", "requirementIds", "category", "impact", "likelihood", "rationale", "evidence"],
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          requirementId: { type: "string" },
          question: { type: "string" },
          whyItMatters: { type: "string" },
        },
        required: ["question", "whyItMatters"],
      },
    },
    missingRequirements: {
      type: "array",
      items: {
        type: "object",
        properties: { title: { type: "string" }, why: { type: "string" } },
        required: ["title", "why"],
      },
    },
  },
  required: ["feature", "summary", "risks", "questions", "missingRequirements"],
};

// ---------------------------------------------------------------------------
// Designer -> Executor: the test plan
// ---------------------------------------------------------------------------

export const TECHNIQUES = [
  "equivalence-partitioning",
  "boundary-values",
  "decision-table",
  "state-transition",
  "pairwise",
  "error-guessing",
] as const;

export type Technique = (typeof TECHNIQUES)[number];

export interface TestCase {
  id: string; // TC-01, TC-02...
  title: string;
  riskIds: string[]; // R1, R2... from the risk map
  requirementIds: string[]; // booking-rules:FR-005...
  technique: Technique;
  layer: "api" | "ui";
  priority: "p1" | "p2" | "p3";
  preconditions: string[];
  steps: string[];
  /** The input that makes this case different from its neighbors. */
  data: Record<string, unknown>;
  /** The oracle: exactly what must be observed for the test to pass. */
  expected: string;
  /** Set when the oracle depends on an unanswered question. Blocked cases are not automated. */
  blockedBy?: string;
}

export interface TestPlan {
  feature: string;
  cases: TestCase[];
  /** Filled in by code: what curation removed, and why. */
  dropped?: { id: string; title: string; reason: string }[];
}

export const testPlanSchema: JsonSchema = {
  type: "object",
  properties: {
    feature: { type: "string" },
    cases: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "TC-01, TC-02, ..." },
          title: { type: "string", description: "What the test proves, in one sentence." },
          riskIds: { type: "array", minItems: 1, items: { type: "string" }, description: "Risk ids from the risk map." },
          requirementIds: { type: "array", items: { type: "string" } },
          technique: { type: "string", enum: [...TECHNIQUES] },
          layer: { type: "string", enum: ["api", "ui"] },
          priority: { type: "string", enum: ["p1", "p2", "p3"] },
          preconditions: { type: "array", items: { type: "string" } },
          steps: { type: "array", minItems: 1, items: { type: "string" } },
          data: { type: "object", properties: {}, description: "The inputs, as concrete values." },
          expected: { type: "string", description: "The oracle: status, message, and state that must or must not change." },
          blockedBy: { type: "string", description: "Only if the expected result depends on an open question: the question. Leave out otherwise." },
        },
        required: ["id", "title", "riskIds", "requirementIds", "technique", "layer", "priority", "preconditions", "steps", "data", "expected"],
      },
    },
  },
  required: ["feature", "cases"],
};

// ---------------------------------------------------------------------------
// Executor -> Triager: the execution report
// ---------------------------------------------------------------------------

export const OUTCOMES = ["passed", "failing-suspected-product-bug", "blocked"] as const;

export interface ExecutionReport {
  caseId: string;
  file: string;
  outcome: (typeof OUTCOMES)[number];
  attempts: number;
  /** The decisive evidence: the passing run, or the failing assertion with expected and actual values. */
  evidence: string;
  notes: string;
  /** Filled in by code: did an independent re-run agree with the agent's claim? */
  verified?: boolean;
  verification?: string;
}

export const executionReportSchema: JsonSchema = {
  type: "object",
  properties: {
    caseId: { type: "string" },
    file: { type: "string", description: "The file name in tests/generated/" },
    outcome: {
      type: "string",
      enum: [...OUTCOMES],
      description:
        "passed: the test passes and checks the case's oracle. failing-suspected-product-bug: the test is correct and fails on the oracle. blocked: you could not make the test run correctly.",
    },
    attempts: { type: "integer", minimum: 1, description: "How many times you ran the test." },
    evidence: { type: "string", description: "The decisive output: for a failure, the assertion with expected and received values." },
    notes: { type: "string", description: "Anything the reviewer should know, such as assumptions or gate warnings." },
  },
  required: ["caseId", "file", "outcome", "attempts", "evidence", "notes"],
};

// ---------------------------------------------------------------------------
// Triager: from a red build to classified failures and draft bug reports
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = ["product-bug", "test-bug", "environment", "flaky", "needs-human"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** One failing test, as it arrives from a test run or from the Executor. */
export interface Failure {
  file: string; // path from the project root, e.g. tests/generated/tc-02-capacity.spec.ts
  title: string;
  error: string;
  caseId?: string;
  /** The oracle, when the failure comes from a test case in a plan. */
  expected?: string;
}

/** Facts gathered by code before the model sees anything. */
export interface EvidencePack {
  failure: Failure;
  /** Outcome of the original run plus the re-runs, in order. */
  runs: { status: string; error?: string }[];
  /** Did every run fail with the same error headline? */
  consistent: boolean;
  appHealthy: boolean;
  testSource: string;
}

export interface BugReport {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  summary: string;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  requirementIds: string[];
  suspectedArea: string;
}

export interface TriageItem {
  file: string;
  title: string;
  caseId?: string;
  classification: Classification;
  confidence: "high" | "medium" | "low";
  rationale: string;
  evidence: string[];
  /** An existing issue this failure is already reported as. */
  duplicateOf?: string;
  /** For a new product bug: a draft a developer can act on. */
  bugReport?: BugReport;
  /** For a test bug: the change a human should make. The Triager never edits tests. */
  testFix?: { summary: string; change: string };
  /** For a flaky test: the likely cause. */
  flakinessCause?: string;
  // Filled in by code:
  warnings?: string[];
}

export const triageItemSchema: JsonSchema = {
  type: "object",
  properties: {
    classification: { type: "string", enum: [...CLASSIFICATIONS] },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    rationale: { type: "string", description: "Why this classification, in two or three sentences, citing the evidence." },
    evidence: { type: "array", minItems: 1, items: { type: "string" } },
    duplicateOf: { type: "string", description: "Only if search_issues found the same problem already reported: its id, e.g. ISSUE-0031." },
    bugReport: {
      type: "object",
      description: "Only for a NEW product bug (not a duplicate).",
      properties: {
        title: { type: "string", description: "What is broken, from the user's point of view." },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
        summary: { type: "string" },
        stepsToReproduce: { type: "array", minItems: 1, items: { type: "string" } },
        expected: { type: "string", description: "Cite the requirement id." },
        actual: { type: "string" },
        requirementIds: { type: "array", items: { type: "string" } },
        suspectedArea: { type: "string", description: "Where in the code the fix probably belongs." },
      },
      required: ["title", "severity", "summary", "stepsToReproduce", "expected", "actual", "requirementIds", "suspectedArea"],
    },
    testFix: {
      type: "object",
      description: "Only for a test bug: the change a human should make to the test.",
      properties: { summary: { type: "string" }, change: { type: "string", description: "The lines to change, before and after." } },
      required: ["summary", "change"],
    },
    flakinessCause: { type: "string", description: "Only for a flaky test: the most likely cause." },
  },
  required: ["classification", "confidence", "rationale", "evidence"],
};
