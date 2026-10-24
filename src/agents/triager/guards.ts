import type { EvidencePack, TriageItem } from "../../crew/contracts.ts";

// Code checks the Triager's classification against the evidence it was given.
// A guard never makes a failure look better than the evidence says: when the
// classification and the facts disagree, the failure goes to a human.

const STATUS_ASSERTION = /Expected:\s*(\d{3})\b[\s\S]*Received:\s*(\d{3})\b/;

export function applyGuards(item: TriageItem, pack: EvidencePack, knownIssueIds: Set<string>): TriageItem {
  const warnings: string[] = [];
  let classification = item.classification;
  const passes = pack.runs.filter((r) => r.status === "passed").length;

  // 1. "Flaky" needs evidence of flakiness: at least one passing run.
  if (classification === "flaky" && passes === 0) {
    warnings.push(`Classified as flaky, but all ${pack.runs.length} runs failed. A consistent failure is not flaky.`);
    classification = "needs-human";
  }

  // 2. Mixed results deserve a mention whatever the classification.
  if (passes > 0 && classification !== "flaky") {
    warnings.push(`${passes} of ${pack.runs.length} runs passed. If this is a product bug, it is intermittent: say so in the report.`);
  }

  // 3. A test bug must not hide a product bug. A wrong HTTP status is the classic oracle failure.
  const status = pack.failure.error.match(STATUS_ASSERTION);
  if (classification === "test-bug" && status) {
    warnings.push(
      `The test fails on an HTTP status (expected ${status[1]}, received ${status[2]}). Calling this a test bug would ` +
        "change the oracle. A human must confirm the expected status is wrong.",
    );
    classification = "needs-human";
  }

  // 4. The environment was down: nothing else can be concluded.
  if (!pack.appHealthy && classification !== "environment") {
    warnings.push("The runs show signs of an environment problem (connection refused, server did not start). Fix that first.");
  }

  // 5. Duplicates must point at a real issue; product bugs need a report unless they are duplicates.
  let duplicateOf = item.duplicateOf;
  if (duplicateOf && !knownIssueIds.has(duplicateOf)) {
    warnings.push(`Marked as a duplicate of ${duplicateOf}, which does not exist in the tracker.`);
    duplicateOf = undefined;
  }
  if (classification === "product-bug" && !duplicateOf && !item.bugReport) {
    warnings.push("A new product bug needs a bug report.");
    classification = "needs-human";
  }

  return {
    ...item,
    classification,
    ...(duplicateOf ? { duplicateOf } : { duplicateOf: undefined }),
    ...(warnings.length > 0 ? { warnings: [...(item.warnings ?? []), ...warnings] } : {}),
  };
}
