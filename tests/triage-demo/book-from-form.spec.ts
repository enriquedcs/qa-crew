import { test, expect } from "../support/fixtures.ts";

test("a guest books a room from the form", { tag: ["@booking-rules:FR-002"] }, async ({ bookingApi, bookingPage, page }) => {
  await bookingPage.open();
  await bookingPage.guestName.fill("Ana Prueba");
  await bookingPage.room.selectOption("r2");
  await bookingPage.guests.fill("2");
  await bookingPage.checkIn.fill("2031-03-01");
  await bookingPage.checkOut.fill("2031-03-03");
  await page.getByRole("button", { name: "Book now" }).click({ timeout: 3000 });

  await expect(bookingPage.status).toHaveText("Booking confirmed for Ana Prueba.");
  expect(await bookingApi.list()).toHaveLength(1);
});
