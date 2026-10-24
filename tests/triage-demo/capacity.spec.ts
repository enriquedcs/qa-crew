import { test, expect } from "../support/fixtures.ts";

test("the API rejects 3 guests in the City Double", { tag: ["@booking-rules:FR-005"] }, async ({ bookingApi }) => {
  const res = await bookingApi.create({ roomId: "r2", guests: 3 });

  expect(res.status()).toBe(400);
  expect(await bookingApi.list()).toHaveLength(0);
});
