import { test, expect } from "@playwright/test";

// Executable acceptance checks for specs/001-booking-rules/spec.md.
// Each test carries the id of the requirement it checks as a tag, so
// `npm run trace` can tell which requirements have no test and which
// tags no longer match the spec.

const booking = (overrides: Record<string, unknown> = {}) => ({
  guestName: "Ana",
  roomId: "r2",
  guests: 2,
  checkIn: "2030-05-01",
  checkOut: "2030-05-03",
  ...overrides,
});

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("every room shows its capacity and price", { tag: "@booking-rules:FR-001" }, async ({ request }) => {
  const rooms = await (await request.get("/api/rooms")).json();
  for (const room of rooms) {
    expect(room).toEqual(expect.objectContaining({ capacity: expect.any(Number), pricePerNight: expect.any(Number) }));
  }
});

test("a valid booking is stored and returned with an id", { tag: "@booking-rules:FR-002" }, async ({ request }) => {
  const res = await request.post("/api/bookings", { data: booking() });
  expect(res.status()).toBe(201);
  const created = await res.json();
  expect(created.id).toBeTruthy();
  expect(await (await request.get("/api/bookings")).json()).toContainEqual(created);
});

test("a blank guest name is rejected", { tag: "@booking-rules:FR-003" }, async ({ request }) => {
  const res = await request.post("/api/bookings", { data: booking({ guestName: "   " }) });
  expect(res.status()).toBe(400);
  expect((await res.json()).errors).toContain("guestName is required");
});

for (const guests of [0, -1, 1.5]) {
  test(`guests = ${guests} is rejected`, { tag: "@booking-rules:FR-004" }, async ({ request }) => {
    const res = await request.post("/api/bookings", { data: booking({ guests }) });
    expect(res.status()).toBe(400);
  });
}

test(
  "the API rejects more guests than the room's capacity",
  {
    tag: "@booking-rules:FR-005",
    annotation: { type: "spec drift", description: "Only the UI enforces capacity; the API accepts any number of guests." },
  },
  async ({ request }) => {
    // Expected to fail until the API enforces FR-005. Playwright reports it as
    // "expected failure"; once the bug is fixed, the test passes and Playwright
    // tells you to remove this line.
    test.fail();
    const res = await request.post("/api/bookings", { data: booking({ roomId: "r1", guests: 3 }) });
    expect(res.status()).toBe(400);
    expect(await (await request.get("/api/bookings")).json()).toHaveLength(0);
  },
);

test("check-out on the same day as check-in is rejected", { tag: "@booking-rules:FR-006" }, async ({ request }) => {
  const res = await request.post("/api/bookings", { data: booking({ checkOut: "2030-05-01" }) });
  expect(res.status()).toBe(400);
  expect((await res.json()).errors).toContain("checkOut must be after checkIn");
});

test(
  "a stay that starts in the past is rejected",
  {
    tag: "@booking-rules:FR-007",
    annotation: { type: "spec drift", description: "The API does not compare check-in with today's date." },
  },
  async ({ request }) => {
    test.fail();
    const res = await request.post("/api/bookings", { data: booking({ checkIn: "2020-01-01", checkOut: "2020-01-03" }) });
    expect(res.status()).toBe(400);
  },
);

test("overlapping stays in the same room are rejected", { tag: "@booking-rules:FR-008" }, async ({ request }) => {
  await request.post("/api/bookings", { data: booking() });
  const res = await request.post("/api/bookings", {
    data: booking({ guestName: "Luis", checkIn: "2030-05-02", checkOut: "2030-05-04" }),
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).errors).toContain("room is already booked for those dates");
});

test("a stay can start on the previous stay's check-out day", { tag: "@booking-rules:FR-009" }, async ({ request }) => {
  await request.post("/api/bookings", { data: booking() });
  const res = await request.post("/api/bookings", {
    data: booking({ guestName: "Luis", checkIn: "2030-05-03", checkOut: "2030-05-05" }),
  });
  expect(res.status()).toBe(201);
});

test("a cancelled booking disappears from the list", { tag: "@booking-rules:FR-010" }, async ({ request }) => {
  const { id } = await (await request.post("/api/bookings", { data: booking() })).json();
  expect((await request.delete(`/api/bookings/${id}`)).status()).toBe(204);
  expect(await (await request.get("/api/bookings")).json()).toHaveLength(0);
});
