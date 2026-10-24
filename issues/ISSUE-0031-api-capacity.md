# ISSUE-0031: The API accepts more guests than the room's capacity

- **Status:** open
- **Severity:** high
- **Area:** validation, API
- **Requirement:** booking-rules:FR-005
- **Reported:** 2026-10-20, while turning the booking rules spec into acceptance checks

## Summary

The booking form refuses more guests than a room fits, but `POST /api/bookings`
does not check capacity at all. Any client that calls the API directly can book
3 guests into the City Double (capacity 2), or more into any room.

## Steps to reproduce

1. `POST /api/bookings` with `{ "guestName": "Ana", "roomId": "r2", "guests": 3, "checkIn": <a future date>, "checkOut": <the day after> }`
2. Observe `201 Created`.

**Expected:** `400 Bad Request`, and no booking stored (FR-005).
**Actual:** `201 Created`; the booking is stored.

## Notes

The acceptance check for FR-005 is marked with `test.fail()` until this is fixed.
Same pattern as BUG-0019 (a rule enforced only in the browser).
