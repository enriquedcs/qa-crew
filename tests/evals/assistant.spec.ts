import { expect, test } from "@playwright/test";
import { askAssistant, assistantModelFromEnv, scriptedAssistant } from "../../src/app/assistant.ts";
import { Store } from "../../src/app/store.ts";
import { ASSISTANT_CASES, checkAnswer, checkSuggestion, claimsAction, mentions, withDates } from "../../src/evals/assistant.ts";
import { calibrateJudge, judge, JUDGE_CALIBRATION, rubberStampJudge } from "../../src/evals/judge.ts";
import { createMockClient } from "../../src/llm/index.ts";

const TODAY = "2030-05-01";
const rooms = new Store().listRooms();
const booked = [{ guestName: "Lucía", roomId: "r2", guests: 2, checkIn: "2030-05-10", checkOut: "2030-05-12" }];

test.describe("oracles for the assistant's suggestion", () => {
  test("a valid suggestion has no violations, and check-out day is free for the next guest", () => {
    expect(checkSuggestion({ roomId: "r2", guests: 2, checkIn: "2030-05-12", checkOut: "2030-05-14" }, rooms, booked, TODAY)).toEqual([]);
  });

  test("capacity, overlap, the past and impossible rooms or stays are each a violation", () => {
    const req = (s: Parameters<typeof checkSuggestion>[0]) => checkSuggestion(s, rooms, booked, TODAY).map((v) => v.requirement.split(":")[1]);
    expect(req({ roomId: "r2", guests: 3, checkIn: "2030-05-02", checkOut: "2030-05-03" })).toEqual(["FR-002"]);
    expect(req({ roomId: "r2", guests: 1, checkIn: "2030-05-11", checkOut: "2030-05-13" })).toEqual(["FR-003"]);
    expect(req({ roomId: "r1", guests: 1, checkIn: "2030-04-30", checkOut: "2030-05-02" })).toEqual(["FR-004"]);
    expect(req({ roomId: "r9", guests: 1, checkIn: "2030-05-03", checkOut: "2030-05-02" })).toEqual(["FR-001", "FR-001"]);
  });

  test("secrets are found whatever their case", () => {
    expect(mentions("The room is booked by LUCÍA until Friday.", ["Lucía", "Fernández"])).toEqual(["Lucía"]);
  });

  test("claims of a booking are caught; explanations and suggestions are not", () => {
    for (const yes of ["I've booked City Double for you.", "Your reservation is confirmed!", "You're all set for Friday.", "Listo, ya he reservado la habitación."]) {
      expect(claimsAction(yes), yes).toBe(true);
    }
    for (const no of ["I can't book for you, but you can confirm this suggestion.", "Confirm it to book.", "City Double is booked on those dates."]) {
      expect(claimsAction(no), no).toBe(false);
    }
  });

  test("relative dates in a case become real dates", () => {
    expect(withDates("from {d:-1} to {d:30}", TODAY)).toBe("from 2030-04-30 to 2030-05-31");
  });
});

test.describe("the scripted assistant", () => {
  const run = async (id: string) => {
    const c = ASSISTANT_CASES.find((x) => x.id === id)!;
    const store = new Store();
    const existing = c.setup.map((b) => ({ ...b, checkIn: withDates(`{d:${b.inDays}}`, TODAY), checkOut: withDates(`{d:${b.outDays}}`, TODAY) }));
    for (const b of existing) store.addBooking(b);
    const reply = (await askAssistant(withDates(c.question, TODAY), store, createMockClient(scriptedAssistant()), () => TODAY))!;
    return { reply, violations: checkAnswer(c, reply, store.listRooms(), existing, TODAY).map((v) => v.requirement.split(":")[1]) };
  };

  test("its two planted mistakes: capacity and other guests' names", async () => {
    expect((await run("AC-01")).violations).toEqual(["FR-002"]);
    expect((await run("AC-02")).violations).toEqual(["FR-005"]);
  });

  test("what it gets right: the past, being asked to book, and off-topic questions", async () => {
    for (const id of ["AC-03", "AC-05", "AC-06"]) expect((await run(id)).violations, id).toEqual([]);
    expect((await run("AC-05")).reply.suggestion).toMatchObject({ roomId: "r1", guests: 1 });
  });
});

test.describe("the assistant's model", () => {
  test("nothing configured means no assistant; ASSISTANT_ wins over QA_; mock is scripted", () => {
    expect(assistantModelFromEnv({})).toBeUndefined();
    expect(assistantModelFromEnv({ QA_MODEL_PROVIDER: "mock" })!().provider).toBe("mock");
    const m = assistantModelFromEnv({ QA_MODEL_PROVIDER: "openai", QA_MODEL: "crew-model", ASSISTANT_MODEL: "app-model", ASSISTANT_MODEL_BASE_URL: "http://localhost:11434/v1" })!();
    expect([m.provider, m.model]).toEqual(["openai-compatible", "app-model"]);
  });
});

test.describe("the judge", () => {
  test("a rubber stamp agrees with the person only on the good answers: the floor", async () => {
    const { results } = await calibrateJudge(createMockClient(rubberStampJudge()));
    const good = JUDGE_CALIBRATION.filter((s) => s.expected === "pass").length;
    expect(results.filter((r) => r.correct).length).toBe(good);
    expect(good).toBe(3);
  });

  test("a pass that names failed criteria is a fail", async () => {
    const model = createMockClient([{ toolCalls: [{ name: "submit_result", input: { verdict: "pass", failed: ["private"], reason: "Mostly fine." } }] }]);
    const { judgment } = await judge(model, { question: "q", facts: "f", answer: "a" });
    expect(judgment).toEqual({ verdict: "fail", failed: ["private"], reason: "Mostly fine." });
  });

  test("a judge that finds the planted defect under the right criterion is correct", async () => {
    const turns = JUDGE_CALIBRATION.map((s) => ({
      toolCalls: [{ name: "submit_result", input: s.defect ? { verdict: "fail", failed: [s.defect], reason: "r" } : { verdict: "pass", failed: [], reason: "r" } }],
    }));
    const { results } = await calibrateJudge(createMockClient(turns));
    expect(results.every((r) => r.correct)).toBe(true);
  });
});
