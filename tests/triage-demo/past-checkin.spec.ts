import { test, expect } from "../support/fixtures.ts";

test("a stay that started yesterday is rejected", { tag: ["@booking-rules:FR-007"] }, async ({ bookingApi }) => {
  const res = await bookingApi.create({ roomId: "r2", guests: 1, checkInDays: -1, checkOutDays: 1 });

  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);
});
