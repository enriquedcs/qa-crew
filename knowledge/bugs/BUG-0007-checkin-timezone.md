# BUG-0007: Check-in "today" rejected for guests in Asia

- **Severity:** high
- **Area:** booking dates, validation
- **Found by:** customer support, after complaints from guests in Tokyo
- **Status:** fixed (2025-11), reintroduced risk whenever date validation changes

A guest in Tokyo tried to book a room starting "today" in their time zone. The
server compared the date with "today" in UTC, where it was still yesterday, and
rejected the booking as "in the past". The opposite also happened: guests in the
Americas could book a night that had already started at the hotel.

**Root cause:** date rules used the server clock without deciding whose "today"
counts.

**Lesson:** every rule that mentions "today" needs an explicit time zone, and tests
must cover the hours around midnight.
