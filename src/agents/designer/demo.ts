import type { MockTurn } from "../../llm/index.ts";

// The scripted Designer used when QA_MODEL_PROVIDER=mock. TC-03 duplicates TC-02 and TC-11 cites
// a risk that does not exist, so curation has real work to do.

const api = (title: string, extra: object) => ({ layer: "api", preconditions: ["Test data is reset"], ...extra, title });

export function scriptedDesigner(feature = "booking-rules"): MockTurn[] {
  return [
    { text: "Read the rules, the API and the rooms first.", toolCalls: [{ name: "list_requirements", input: { key: feature } }, { name: "get_api_reference", input: {} }, { name: "list_rooms", input: {} }] },
    { text: "What is already tested?", toolCalls: [{ name: "read_test_file", input: { path: "spec/booking-rules.spec.ts" } }] },
    { text: "Exact boundaries for a room of capacity 2, and the dates around today.", toolCalls: [{ name: "boundary_values", input: { min: 1, max: 2 } }, { name: "relative_dates", input: { offsets: [-1, 0, 1, 3, 5] } }] },
    {
      toolCalls: [
        {
          name: "submit_result",
          input: {
            feature,
            cases: [
              api("A double room accepts exactly 2 guests", { id: "TC-01", riskIds: ["R1"], requirementIds: ["booking-rules:FR-005"], technique: "boundary-values", priority: "p2", steps: ["POST /api/bookings for room r2 with 2 guests"], data: { roomId: "r2", guests: 2, checkInDays: 30, checkOutDays: 32 }, expected: "201 Created and the booking appears in GET /api/bookings" }),
              api("The API rejects 3 guests for a room of capacity 2", { id: "TC-02", riskIds: ["R1"], requirementIds: ["booking-rules:FR-005"], technique: "boundary-values", priority: "p1", steps: ["POST /api/bookings for room r2 with 3 guests", "GET /api/bookings"], data: { roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 }, expected: "400 Bad Request and no booking is stored" }),
              api("API refuses three guests in a double room", { id: "TC-03", riskIds: ["R1"], requirementIds: ["booking-rules:FR-005"], technique: "equivalence-partitioning", priority: "p1", steps: ["POST /api/bookings for room r2 with 3 guests"], data: { roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 }, expected: "400 Bad Request and no booking is stored" }),
              { id: "TC-04", title: "The form explains the capacity limit before submitting", riskIds: ["R1"], requirementIds: ["booking-rules:FR-005"], technique: "boundary-values", layer: "ui", priority: "p2", preconditions: ["Test data is reset", "The booking page is open"], steps: ["Choose City Double", "Enter 3 guests", "Press Book room"], data: { roomId: "r2", guests: 3, checkInDays: 30, checkOutDays: 32 }, expected: "The status message says 'This room fits up to 2 guests.' and the bookings table stays empty" },
              api("A stay that started yesterday is rejected", { id: "TC-05", riskIds: ["R2"], requirementIds: ["booking-rules:FR-007"], technique: "boundary-values", priority: "p1", steps: ["POST /api/bookings with check-in yesterday"], data: { roomId: "r2", guests: 1, checkInDays: -1, checkOutDays: 1 }, expected: "400 Bad Request and no booking is stored" }),
              api("A stay that starts today is accepted", { id: "TC-06", riskIds: ["R2"], requirementIds: ["booking-rules:FR-007"], technique: "boundary-values", priority: "p1", steps: ["POST /api/bookings with check-in today"], data: { roomId: "r2", guests: 1, checkInDays: 0, checkOutDays: 2 }, expected: "201 Created" }),
              api("Two simultaneous requests for the same room and nights produce exactly one booking", { id: "TC-07", riskIds: ["R3"], requirementIds: ["booking-rules:FR-008"], technique: "error-guessing", priority: "p1", steps: ["Send two identical POST /api/bookings at the same time (BUG-0012)", "GET /api/bookings"], data: { roomId: "r3", guests: 2, checkInDays: 10, checkOutDays: 12, parallelRequests: 2 }, expected: "Exactly one 201 and one 400 'room is already booked for those dates'; exactly one booking stored" }),
              api("A stay may end on the day another stay starts", { id: "TC-08", riskIds: ["R4"], requirementIds: ["booking-rules:FR-009"], technique: "boundary-values", priority: "p2", preconditions: ["Room r2 is booked from day 5 to day 7"], steps: ["POST /api/bookings for r2 from day 3 to day 5"], data: { roomId: "r2", guests: 1, checkInDays: 3, checkOutDays: 5, existing: { checkInDays: 5, checkOutDays: 7 } }, expected: "201 Created" }),
              api("A stay that overlaps the first night of another stay is rejected", { id: "TC-09", riskIds: ["R4"], requirementIds: ["booking-rules:FR-008"], technique: "boundary-values", priority: "p2", preconditions: ["Room r2 is booked from day 5 to day 7"], steps: ["POST /api/bookings for r2 from day 3 to day 6"], data: { roomId: "r2", guests: 1, checkInDays: 3, checkOutDays: 6, existing: { checkInDays: 5, checkOutDays: 7 } }, expected: "400 'room is already booked for those dates'" }),
              api("Cancelling a booking twice returns 404 the second time", { id: "TC-10", riskIds: ["R5"], requirementIds: ["booking-rules:FR-010"], technique: "state-transition", priority: "p3", steps: ["Create a booking", "DELETE it", "DELETE it again"], data: { roomId: "r1", guests: 1, checkInDays: 20, checkOutDays: 21 }, expected: "First DELETE 204, second DELETE 404" }),
              api("Guest names with emoji are stored unchanged", { id: "TC-11", riskIds: ["R9"], requirementIds: [], technique: "equivalence-partitioning", priority: "p3", steps: ["POST /api/bookings with an emoji in the name"], data: { guestName: "Ana 🌴" }, expected: "201 and the name is unchanged" }),
            ],
          },
        },
      ],
    },
  ];
}
