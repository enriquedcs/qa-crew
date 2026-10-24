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
