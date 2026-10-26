import type { Classification, ExecutionReport } from "../crew/contracts.ts";

// Chapter 12: the golden sets. What a good answer contains, written down by a person
// BEFORE any model runs, so the eval measures the agent against the team's judgment
// and not against whatever the last model happened to say.
//
// Golden sets are about what must be in the answer, never about its exact words.
// Two good risk maps can be worded in a hundred ways; both must find the capacity bug.

/** A risk the Analyst must find in booking-rules. A risk matches if it cites the requirement or its title matches. */
export interface MustFind {
  name: string;
  requirement: string; // the suffix of the requirement id, e.g. FR-005
  title: RegExp;
}

export const ANALYST_MUST_FIND: MustFind[] = [
  { name: "The API ignores room capacity", requirement: "FR-005", title: /capacit|more guests|overbook/i },
  { name: "Stays that start in the past", requirement: "FR-007", title: /past|yesterday|today/i },
  { name: "Overlapping or simultaneous bookings", requirement: "FR-008", title: /overlap|double[- ]?book|simultaneous|concurren|race/i },
  { name: "Off-by-one on the check-out day", requirement: "FR-009", title: /check-?out day|back-to-back|off-by-one|adjacent|same day/i },
  { name: "Cancelling a booking", requirement: "FR-010", title: /cancel/i },
];

/** FR-007 cannot be tested until someone says whose "today" counts. A good Analyst asks. */
export const TODAY_QUESTION = /time ?zone|whose .?today|utc|hotel's|guest's/i;

/** The Analyst should know capacity is the riskiest rule: an open issue (ISSUE-0031) and a past bug (BUG-0019). */
export const CAPACITY_LEVEL = "high";

/** A focused risk map: the Analyst's prompt asks for 5 to 10 sharp risks. */
export const RISK_COUNT = { min: 5, max: 10 };

/**
 * The Executor's truth table: what each case MUST end as, against the app as it is.
 * The booking app has seeded bugs: it ignores capacity in the API and accepts stays in the past.
 * Back-to-back stays work. A green test for a red rule is a miss, however good the test looks.
 */
export const EXECUTOR_TRUTH: Record<string, { outcome: ExecutionReport["outcome"]; why: string }> = {
  "TC-02": { outcome: "failing-suspected-product-bug", why: "The API books 3 guests into a room for 2 (ISSUE-0031)" },
  "TC-05": { outcome: "failing-suspected-product-bug", why: "The API accepts a stay that started yesterday (FR-007)" },
  "TC-08": { outcome: "passed", why: "A stay may start on another stay's check-out day (FR-009)" },
};

/** The Triager's truth: the four failures of the demo red build, and why each one fails. */
export interface TriageTruth {
  file: string;
  classification: Classification;
  duplicateOf?: string;
  /** For a new product bug: the requirement its report must cite. */
  cites?: string;
}

export const TRIAGE_TRUTH: TriageTruth[] = [
  { file: "tests/triage-demo/past-checkin.spec.ts", classification: "product-bug", cites: "FR-007" },
  { file: "tests/triage-demo/capacity.spec.ts", classification: "product-bug", duplicateOf: "ISSUE-0031" },
  { file: "tests/triage-demo/book-from-form.spec.ts", classification: "test-bug" },
  { file: "tests/triage-demo/new-booking-row.spec.ts", classification: "flaky" },
];
