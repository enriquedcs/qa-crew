import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures.ts";

// Simulated flakiness, made deterministic so the book's example is reproducible:
// on every other run the list of bookings is slow to load (1.5 s), and the test only
// waits 500 ms for the new row. Real flaky tests come from exactly this kind of race,
// a wait that is usually long enough, without the counter.
const counterFile = path.join(os.tmpdir(), "qa-crew-flaky-demo.txt");
function nextRun(): number {
  let n = 0;
  try {
    n = Number(readFileSync(counterFile, "utf8")) || 0;
  } catch {
    // first run
  }
  writeFileSync(counterFile, String(n + 1));
  return n + 1;
}

test("a new booking appears in the bookings table", { tag: ["@booking-rules:FR-002"] }, async ({ bookingApi, bookingPage, page }) => {
  const slowBackend = nextRun() % 2 === 1;
  if (slowBackend) {
    await page.route("**/api/bookings", async (route) => {
      if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
  }
  await bookingApi.reset();
  await bookingPage.open();
  await bookingPage.book({ guestName: "Ana Prueba", roomId: "r1", guests: 1 });

  await expect(bookingPage.bookings).toContainText("Ana Prueba", { timeout: 500 });
});
