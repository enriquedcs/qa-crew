import { test as base, expect, type APIRequestContext, type APIResponse, type Locator, type Page } from "@playwright/test";
import { daysFromToday } from "./dates.ts";

// Shared fixtures and page objects. Humans and agents use the same ones:
// the Executor reads this file before writing a test, so generated tests
// follow the team's conventions instead of inventing their own.

export interface NewBooking {
  guestName?: string;
  roomId?: string;
  guests?: number;
  /** Days from today; converted to YYYY-MM-DD. */
  checkInDays?: number;
  checkOutDays?: number;
}

/** The booking API, with test data described as offsets from today. */
export class BookingApi {
  constructor(private readonly request: APIRequestContext) {}

  async reset(): Promise<void> {
    expect((await this.request.post("/api/test/reset")).status()).toBe(204);
  }

  /** Send a booking request. Returns the raw response: a 400 is something to assert on, not an error. */
  create(booking: NewBooking = {}): Promise<APIResponse> {
    const { guestName = "Ana Prueba", roomId = "r2", guests = 1, checkInDays = 30, checkOutDays = checkInDays + 2 } = booking;
    return this.request.post("/api/bookings", {
      data: { guestName, roomId, guests, checkIn: daysFromToday(checkInDays), checkOut: daysFromToday(checkOutDays) },
    });
  }

  async list(): Promise<{ id: string; roomId: string; guestName: string; guests: number; checkIn: string; checkOut: string }[]> {
    return (await this.request.get("/api/bookings")).json();
  }

  cancel(id: string): Promise<APIResponse> {
    return this.request.delete(`/api/bookings/${encodeURIComponent(id)}`);
  }
}

/** The booking page, located by role and label like a user would find things. */
export class BookingPage {
  readonly guestName: Locator;
  readonly room: Locator;
  readonly guests: Locator;
  readonly checkIn: Locator;
  readonly checkOut: Locator;
  readonly bookButton: Locator;
  readonly status: Locator;
  readonly bookings: Locator;

  constructor(private readonly page: Page) {
    this.guestName = page.getByLabel("Guest name");
    this.room = page.getByLabel("Room");
    this.guests = page.getByLabel("Guests");
    this.checkIn = page.getByLabel("Check-in");
    this.checkOut = page.getByLabel("Check-out");
    this.bookButton = page.getByRole("button", { name: "Book room" });
    this.status = page.getByRole("status");
    this.bookings = page.getByRole("table", { name: "Bookings" });
  }

  async open(): Promise<void> {
    await this.page.goto("/");
  }

  async book(booking: NewBooking = {}): Promise<void> {
    const { guestName = "Ana Prueba", roomId = "r2", guests = 1, checkInDays = 30, checkOutDays = checkInDays + 2 } = booking;
    await this.guestName.fill(guestName);
    await this.room.selectOption(roomId);
    await this.guests.fill(String(guests));
    await this.checkIn.fill(daysFromToday(checkInDays));
    await this.checkOut.fill(daysFromToday(checkOutDays));
    await this.bookButton.click();
  }
}

/** `test` with a clean booking app and both helpers ready to use. */
export const test = base.extend<{ bookingApi: BookingApi; bookingPage: BookingPage }>({
  bookingApi: async ({ request }, use) => {
    const api = new BookingApi(request);
    await api.reset();
    await use(api);
  },
  bookingPage: async ({ page }, use) => {
    await use(new BookingPage(page));
  },
});

export { expect, daysFromToday };
