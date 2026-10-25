import type { ReviewFinding, TestCase } from "../../crew/contracts.ts";

// Cheap checks that code can make before a model reads the test. They do not replace the
// Reviewer: they find the obvious problems for free, and point the Reviewer at the suspicious ones.
//   facts:       certain from the text alone (a status the case expects is never asserted).
//                A fact cannot be approved away.
//   suspicions:  patterns that are often wrong (two bookings in one room when a rejection is expected).
//                The Reviewer confirms or dismisses each one, and says why.

const lineOf = (source: string, needle: RegExp | string): number | undefined => {
  const lines = source.split("\n");
  const i = lines.findIndex((l) => (typeof needle === "string" ? l.includes(needle) : needle.test(l)));
  return i >= 0 ? i + 1 : undefined;
};

/** HTTP statuses named in the case's expected result, for example "400 Bad Request". */
export function expectedStatuses(expected: string): number[] {
  return [...new Set([...expected.matchAll(/\b([1-5]\d\d)\b/g)].map((m) => Number(m[1])))];
}

/** HTTP statuses the test asserts, for example expect(res.status()).toBe(400). */
export function assertedStatuses(source: string): number[] {
  return [...new Set([...source.matchAll(/\.status\(\)\)\s*\.toBe\(\s*([1-5]\d\d)\s*\)/g)].map((m) => Number(m[1])))];
}

/** Text the expected result quotes, for example 'room is already booked for those dates'. */
export function quotedMessages(expected: string): string[] {
  return [...expected.matchAll(/['"“]([^'"”]{6,})['"”]/g)].map((m) => m[1]);
}

const MENTIONS_STATE = /\b(stored|no booking|appears in|listed|exactly one booking|state)\b/i;
const CHECKS_STATE = /bookingApi\.list\(\)|request\.get\(\s*["'`]\/api\/bookings|bookingPage\.bookings/;

/** The rooms of every booking the test creates. A create() call without a roomId uses the fixture's default, r2. */
function createdRooms(source: string): string[] {
  const calls = [...source.matchAll(/\.create\(\s*(\{[^)]*\})?\s*\)/g)];
  return calls.map((m) => m[1]?.match(/roomId:\s*["'`](\w+)["'`]/)?.[1] ?? "r2");
}

export interface PreReview {
  facts: ReviewFinding[];
  suspicions: ReviewFinding[];
}

export function preReview(testCase: TestCase, source: string): PreReview {
  const findings: ReviewFinding[] = [];
  const suspicions: ReviewFinding[] = [];
  const found = (f: Omit<ReviewFinding, "source">) => findings.push({ ...f, source: "code" });

  // 1. Every status the case expects must be asserted. Asserting a different one instead is weakening.
  const expected = expectedStatuses(testCase.expected);
  const asserted = assertedStatuses(source);
  for (const status of expected.filter((s) => !asserted.includes(s))) {
    const other = asserted.find((a) => Math.floor(a / 100) !== Math.floor(status / 100));
    found({
      check: other ? "no-weakening" : "oracle-complete",
      severity: "blocker",
      line: other ? lineOf(source, `toBe(${other})`) : undefined,
      problem: other
        ? `The case expects ${status}, but the test asserts ${other} and never ${status}.`
        : `The case expects ${status}, but the test never asserts that status.`,
      suggestion: `Assert expect(res.status()).toBe(${status}) on the response the case is about.`,
    });
  }

  // 2. A message the case quotes must appear in the test.
  for (const message of quotedMessages(testCase.expected).filter((m) => !source.includes(m))) {
    found({ check: "oracle-complete", severity: "major", problem: `The case expects the message "${message}", and the test never checks it.`, suggestion: "Assert the error message from the response body as well as the status." });
  }

  // 3. If the case talks about stored state, the test must look at it.
  if (MENTIONS_STATE.test(testCase.expected) && !CHECKS_STATE.test(source)) {
    found({ check: "oracle-complete", severity: "major", problem: `The case's expected result is about stored state ("${testCase.expected}"), and the test never reads the bookings.`, suggestion: "Read the bookings with bookingApi.list() and assert what must, or must not, be there." });
  }

  // 4. Traceability: the case id and every requirement id as tags.
  const missingTags = [testCase.id, ...testCase.requirementIds].filter((id) => !source.includes(`@${id}`));
  if (missingTags.length > 0) {
    found({ check: "traceable", severity: "minor", line: lineOf(source, /\btest\(/), problem: `Missing tags: ${missingTags.map((t) => `@${t}`).join(", ")}.`, suggestion: `Add them to the test's tag list.` });
  }

  // 5. A suspicion for the Reviewer: a rejection is expected, and the test books the same room twice.
  // The overlap rule could produce the rejection instead of the rule the case is about.
  const rooms = createdRooms(source);
  const repeated = rooms.find((r, i) => rooms.indexOf(r) !== i);
  const expectsRejection = expected.some((s) => s >= 400 && s < 500);
  const aboutOverlap = /already booked|overlap/i.test(testCase.expected + testCase.title);
  if (repeated && expectsRejection && !aboutOverlap) {
    suspicions.push({
      source: "code",
      check: "right-reason",
      severity: "major",
      line: lineOf(source, ".create("),
      problem: `The case expects a rejection, and the test creates ${rooms.filter((r) => r === repeated).length} bookings in room ${repeated}. The overlap rule may be what rejects the request, not the rule this case is about.`,
      suggestion: "Give the request under test its own room or dates that cannot overlap, and assert the error message, not only the status.",
    });
  }

  return { facts: findings, suspicions };
}
