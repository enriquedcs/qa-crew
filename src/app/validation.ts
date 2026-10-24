import type { NewBooking, Store } from "./store.ts";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: NewBooking;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Two stays overlap when one starts before the other ends. */
export function overlaps(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && bIn < aOut;
}

export function validateBooking(body: unknown, store: Store): ValidationResult {
  const errors: string[] = [];
  const b = (body ?? {}) as Record<string, unknown>;

  const guestName = typeof b.guestName === "string" ? b.guestName.trim() : "";
  if (!guestName) errors.push("guestName is required");

  const roomId = typeof b.roomId === "string" ? b.roomId : "";
  const room = store.getRoom(roomId);
  if (!room) errors.push("roomId must be an existing room");

  const guests = Number(b.guests);
  if (!Number.isInteger(guests) || guests < 1) errors.push("guests must be a whole number of at least 1");

  const checkIn = b.checkIn;
  const checkOut = b.checkOut;
  if (!isValidDate(checkIn)) errors.push("checkIn must be a date in YYYY-MM-DD format");
  if (!isValidDate(checkOut)) errors.push("checkOut must be a date in YYYY-MM-DD format");

  if (isValidDate(checkIn) && isValidDate(checkOut) && checkOut <= checkIn) {
    errors.push("checkOut must be after checkIn");
  }

  if (errors.length === 0 && room) {
    const clash = store
      .bookingsForRoom(room.id)
      .some((existing) => overlaps(checkIn as string, checkOut as string, existing.checkIn, existing.checkOut));
    if (clash) errors.push("room is already booked for those dates");
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    value: { guestName, roomId, guests, checkIn: checkIn as string, checkOut: checkOut as string },
  };
}
