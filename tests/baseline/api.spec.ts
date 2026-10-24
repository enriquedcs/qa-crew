import { test, expect } from "@playwright/test";

// The baseline suite: a typical hand-written starting point.
// Happy paths plus a couple of obvious validations — nothing more.

test.beforeEach(async ({ request }) => {
  await request.post("/api/test/reset");
});

test("lists the available rooms", async ({ request }) => {
  const res = await request.get("/api/rooms");
  expect(res.ok()).toBeTruthy();
  const rooms = await res.json();
  expect(rooms).toHaveLength(3);
});

test("creates a booking", async ({ request }) => {
  const res = await request.post("/api/bookings", {
    data: { guestName: "Ana", roomId: "r2", guests: 2, checkIn: "2030-05-01", checkOut: "2030-05-03" },
  });
  expect(res.status()).toBe(201);
  const booking = await res.json();
  expect(booking.guestName).toBe("Ana");
});

test("rejects a booking without a guest name", async ({ request }) => {
  const res = await request.post("/api/bookings", {
    data: { guestName: "", roomId: "r2", guests: 1, checkIn: "2030-05-01", checkOut: "2030-05-02" },
  });
  expect(res.status()).toBe(400);
});

test("rejects a double booking for the same room", async ({ request }) => {
  const first = { guestName: "Ana", roomId: "r1", guests: 1, checkIn: "2030-06-01", checkOut: "2030-06-05" };
  await request.post("/api/bookings", { data: first });
  const res = await request.post("/api/bookings", {
    data: { ...first, guestName: "Luis", checkIn: "2030-06-03", checkOut: "2030-06-07" },
  });
  expect(res.status()).toBe(400);
});

test("cancels a booking", async ({ request }) => {
  const created = await request.post("/api/bookings", {
    data: { guestName: "Ana", roomId: "r3", guests: 3, checkIn: "2030-07-01", checkOut: "2030-07-04" },
  });
  const { id } = await created.json();
  const res = await request.delete(`/api/bookings/${id}`);
  expect(res.status()).toBe(204);
});
