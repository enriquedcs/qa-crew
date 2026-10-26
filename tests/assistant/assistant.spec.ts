import { expect, test } from "../support/fixtures.ts";
import { daysFromToday } from "../support/dates.ts";
import { ASSISTANT_CASES, checkAnswer, withDates, type ExistingBooking } from "../../src/evals/assistant.ts";

// Chapter 14: the booking assistant, through its API, as a guest would use it.
//
// The answer's words change from run to run; these tests never look at them, except to make sure
// that secrets are not in them. They check the suggestion against the booking rules, every trial.
//
//   npm test -- tests/assistant                                         # the scripted assistant
//   ASSISTANT_MODEL_PROVIDER=anthropic ASSISTANT_MODEL=claude-sonnet-5-5 \
//   ASSISTANT_MODEL_API_KEY=... ASSISTANT_TRIALS=3 npm test -- tests/assistant   # a real model, 3 trials
//
// The scripted assistant has two mistakes planted on purpose, like the API's bugs. With it, the
// cases that catch them are expected failures, the same convention as FR-005 in tests/spec/.

const TRIALS = Number(process.env.ASSISTANT_TRIALS ?? 1);

/** What the scripted assistant gets wrong, on purpose. A real model gets no such allowance. */
const SCRIPTED_MISTAKES: Record<string, string> = {
  "AC-01": "the scripted assistant ignores room capacity (FR-002)",
  "AC-02": "the scripted assistant names the guest who booked the room (FR-005)",
  "AC-04": "the scripted assistant repeats the guest name from the schedule (FR-005)",
};

/** Tags written out, so traceability (npm run trace) can read them without running anything. */
const TAGS: Record<string, string[]> = {
  "AC-01": ["@AC-01", "@booking-assistant:FR-001", "@booking-assistant:FR-002"],
  "AC-02": ["@AC-02", "@booking-assistant:FR-003", "@booking-assistant:FR-005"],
  "AC-03": ["@AC-03", "@booking-assistant:FR-004"],
  "AC-04": ["@AC-04", "@booking-assistant:FR-003", "@booking-assistant:FR-005", "@booking-assistant:FR-006", "@booking-assistant:FR-007"],
  "AC-05": ["@AC-05", "@booking-assistant:FR-006"],
  "AC-06": ["@AC-06", "@booking-assistant:FR-008"],
};

test("every case is tagged with exactly its requirements", () => {
  for (const c of ASSISTANT_CASES) expect(TAGS[c.id], c.id).toEqual([`@${c.id}`, ...c.requirements.map((r) => `@${r}`)]);
});

for (const c of ASSISTANT_CASES) {
  test(`${c.id} ${c.title}`, { tag: TAGS[c.id] }, async ({ bookingApi, request }) => {
    test.setTimeout(60_000 * TRIALS);
    const today = daysFromToday(0);
    const existing: ExistingBooking[] = [];
    for (const b of c.setup) {
      const res = await bookingApi.create({ guestName: b.guestName, roomId: b.roomId, guests: b.guests, checkInDays: b.inDays, checkOutDays: b.outDays });
      expect(res.status(), "setup booking").toBe(201);
      existing.push({ guestName: b.guestName, roomId: b.roomId, guests: b.guests, checkIn: daysFromToday(b.inDays), checkOut: daysFromToday(b.outDays) });
    }
    const rooms = await (await request.get("/api/rooms")).json();

    // Safety rules hold in EVERY trial, or they do not hold.
    for (let trial = 1; trial <= TRIALS; trial++) {
      const res = await request.post("/api/assistant", { data: { message: withDates(c.question, today) } });
      expect(res.status(), `trial ${trial}`).toBe(200);
      const reply = await res.json();
      test.fail(reply.model.startsWith("mock") && c.id in SCRIPTED_MISTAKES, SCRIPTED_MISTAKES[c.id]);

      const violations = checkAnswer(c, reply, rooms, existing, today);
      expect(violations, `trial ${trial} answered: ${reply.answer}`).toEqual([]);
    }

    // The assistant suggests; it never books.
    expect((await bookingApi.list()).length, "bookings after asking").toBe(existing.length);
  });
}

test("the assistant needs a question", { tag: ["@booking-assistant:FR-001"] }, async ({ request }) => {
  const res = await request.post("/api/assistant", { data: { message: "  " } });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ errors: ["message is required"] });
});
