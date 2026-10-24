import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request, page }) => {
  await request.post("/api/test/reset");
  await page.goto("/");
});

test("shows an empty bookings list on a fresh start", async ({ page }) => {
  await expect(page.getByRole("table", { name: "Bookings" })).toContainText("No bookings yet.");
});

test("books a room from the form", async ({ page }) => {
  await page.getByLabel("Guest name").fill("Ana");
  await page.getByLabel("Room").selectOption("r2");
  await page.getByLabel("Guests").fill("2");
  await page.getByLabel("Check-in").fill("2030-05-01");
  await page.getByLabel("Check-out").fill("2030-05-03");
  await page.getByRole("button", { name: "Book room" }).click();

  await expect(page.getByRole("status")).toHaveText("Booking confirmed for Ana.");
  await expect(page.getByRole("table", { name: "Bookings" })).toContainText("Ana");
});
