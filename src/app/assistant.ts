import { runAgent, type Tool } from "../agent/runAgent.ts";
import { createMockClient, createModelFromEnv, type CompletionRequest, type JsonSchema, type MockTurn, type ModelClient } from "../llm/index.ts";
import type { Booking, Room, Store } from "./store.ts";

// Chapter 14: the booking assistant. A guest asks a question in their own words; a language model
// with read-only tools answers and may suggest one booking. It never books: the guest does.
//
// This is the feature under test in Chapter 14, not part of the crew. Like the rest of the app,
// it has mistakes in it on purpose, and the crew's job is to find them.

export interface Suggestion {
  roomId: string;
  guests: number;
  checkIn: string;
  checkOut: string;
}

export interface AssistantReply {
  answer: string;
  suggestion?: Suggestion;
  /** Which model answered: the same question can get a different answer from another model. */
  model: string;
}

export const ASSISTANT_SYSTEM = `You are the booking assistant of a small hotel. Guests ask you about rooms and dates.

Use your tools to look up the rooms, the bookings of a room, and today's date. Never guess them.
When the guest gives a party size and dates, and a room fits and is free, suggest ONE booking.
Rules for a suggestion:
- the room's capacity is at least the number of guests,
- the stay does not overlap any existing booking of that room (check-out day is free for a new check-in),
- check-in is today or later, and check-out is after check-in.
If no room fits, say so and suggest nothing.

You cannot book, change or cancel anything. The guest confirms a suggestion themselves.
Never reveal anything about other guests: not their names, not their party size.
Only talk about rooms, availability and bookings in this hotel.
Answer in two or three friendly sentences, then call submit_result.`;

const answerSchema: JsonSchema = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Your reply to the guest, in plain words." },
    suggestion: {
      type: "object",
      description: "Only when a room fits and is free. Leave it out otherwise.",
      properties: {
        roomId: { type: "string" },
        guests: { type: "integer", minimum: 1 },
        checkIn: { type: "string", description: "YYYY-MM-DD" },
        checkOut: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["roomId", "guests", "checkIn", "checkOut"],
    },
  },
  required: ["answer"],
};

/** The server's today, in UTC. Whose "today" counts is still an open question (FR-007). */
export const utcToday = () => new Date().toISOString().slice(0, 10);

/** The assistant's tools: read-only views of the store. */
export function assistantTools(store: Store, today: () => string = utcToday): Tool[] {
  return [
    {
      name: "list_rooms",
      description: "Every room with its id, name, capacity (maximum guests) and price per night.",
      inputSchema: { type: "object", properties: {} },
      run: async () => store.listRooms(),
    },
    {
      name: "room_schedule",
      description: "The existing bookings of one room, with their dates.",
      inputSchema: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] },
      // Convenient, and a mistake: the assistant only needs the dates, but this hands it the whole
      // booking, guest names included. Whatever a tool returns, the model can repeat.
      run: async ({ roomId }) => store.bookingsForRoom(String(roomId)).map(({ guestName, guests, checkIn, checkOut }) => ({ guestName, guests, checkIn, checkOut })),
    },
    {
      name: "today",
      description: "Today's date, YYYY-MM-DD.",
      inputSchema: { type: "object", properties: {} },
      run: async () => ({ today: today() }),
    },
  ];
}

export type AssistantModel = () => ModelClient;

export async function askAssistant(question: string, store: Store, model: ModelClient, today: () => string = utcToday): Promise<AssistantReply | undefined> {
  const run = await runAgent<{ answer: string; suggestion?: Suggestion }>({
    model,
    system: ASSISTANT_SYSTEM,
    // The guest's words are data: they are quoted, and the model is told so.
    task: `A guest asks (their words, between the markers):\n<<<\n${question}\n>>>`,
    tools: assistantTools(store, today),
    output: { schema: answerSchema, description: "Submit your answer to the guest." },
    maxSteps: 8,
    maxTokens: 1024,
  });
  if (!run.output) return undefined;
  const { answer, suggestion } = run.output;
  return { answer, ...(suggestion ? { suggestion } : {}), model: `${model.provider} / ${model.model}` };
}

/**
 * The assistant's model: ASSISTANT_MODEL_* variables, falling back to QA_MODEL_*.
 * With the mock provider, every question gets a fresh scripted assistant.
 * Returns undefined when nothing is configured: the endpoint then answers 503.
 */
export function assistantModelFromEnv(env: Record<string, string | undefined> = process.env): AssistantModel | undefined {
  const pick = (key: string) => env[`ASSISTANT_${key}`] || env[`QA_${key}`];
  const provider = (pick("MODEL_PROVIDER") ?? "").toLowerCase();
  if (provider === "mock") return () => createMockClient(scriptedAssistant());
  if (!pick("MODEL")) return undefined;
  const mapped = { QA_MODEL_PROVIDER: provider || undefined, QA_MODEL: pick("MODEL"), QA_MODEL_API_KEY: pick("MODEL_API_KEY"), QA_MODEL_BASE_URL: pick("MODEL_BASE_URL") };
  return () => createModelFromEnv(mapped);
}

// ---------------------------------------------------------------------------
// The scripted assistant: a stand-in for a weak model, so the app and its tests run with no API key.
// It reads the tools like a model would, and makes two mistakes on purpose, like the API's bugs:
// it ignores room capacity (FR-002), and it tells the guest who booked a room (FR-005).
// ---------------------------------------------------------------------------

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };

function parseQuestion(text: string): { guests?: number; checkIn?: string; checkOut?: string } {
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const n = text.match(/\b(\d+|one|two|three|four|five|six|uno|dos|tres|cuatro|cinco)\s+(guests?|people|persons?|adults?|personas?|huéspedes)/i);
  const guests = n ? (WORDS[n[1].toLowerCase()] ?? Number(n[1])) : undefined;
  return { guests, checkIn: dates[0], checkOut: dates[1] };
}

function toolResult<T>(request: CompletionRequest, name: string): T[] {
  return request.messages.filter((m) => m.role === "tool" && m.name === name).map((m) => JSON.parse((m as { content: string }).content) as T);
}

export function scriptedAssistant(): MockTurn[] {
  return [
    { toolCalls: [{ name: "today", input: {} }, { name: "list_rooms", input: {} }] },
    (request) => ({
      toolCalls: (toolResult<Room[]>(request, "list_rooms")[0] ?? []).map((r) => ({ name: "room_schedule", input: { roomId: r.id } })),
    }),
    (request) => {
      const question = (request.messages[0] as { content: string }).content;
      const { guests, checkIn, checkOut } = parseQuestion(question);
      const today = toolResult<{ today: string }>(request, "today")[0]?.today ?? "";
      const rooms = toolResult<Room[]>(request, "list_rooms")[0] ?? [];
      const schedules = toolResult<Pick<Booking, "guestName" | "checkIn" | "checkOut">[]>(request, "room_schedule");
      const submit = (answer: string, suggestion?: Suggestion) => ({ toolCalls: [{ name: "submit_result", input: suggestion ? { answer, suggestion } : { answer } }] });

      if (!guests || !checkIn || !checkOut) {
        return submit("I can look for a room for you. How many guests, and which dates (check-in and check-out, YYYY-MM-DD)?");
      }
      if (checkIn < today) return submit(`Check-in on ${checkIn} is in the past. Which dates would you like instead?`);

      // A room the guest names is the only one considered; otherwise every room, in order.
      const named = rooms.findIndex((r) => question.toLowerCase().includes(r.name.toLowerCase()));
      const candidates = named >= 0 ? [named] : rooms.map((_, i) => i);
      const notes: string[] = [];
      for (const i of candidates) {
        const room = rooms[i];
        const clash = (schedules[i] ?? []).find((b) => checkIn < b.checkOut && b.checkIn < checkOut);
        if (clash) {
          notes.push(`${room.name} is booked by ${clash.guestName} from ${clash.checkIn} to ${clash.checkOut}.`);
          continue;
        }
        // Mistake on purpose: the first free room wins, whether or not the party fits.
        const suggestion = { roomId: room.id, guests, checkIn, checkOut };
        return submit(`${notes.join(" ")} ${room.name} is free from ${checkIn} to ${checkOut} for ${guests} guests. Confirm it to book.`.trim(), suggestion);
      }
      return submit(`${notes.join(" ")} Sorry, no room is free for those dates.`.trim());
    },
  ];
}
