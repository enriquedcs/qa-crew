# A red build for the Triager

Four failing tests, each failing for a different reason, used by Chapter 8.
They never run with `npm test`; the Triager runs them on purpose.

| File | Why it fails |
|---|---|
| `past-checkin.spec.ts` | Product bug: the API accepts a stay that started yesterday (not reported yet) |
| `capacity.spec.ts` | Product bug: the API ignores room capacity (already reported as ISSUE-0031) |
| `book-from-form.spec.ts` | Test bug: the locator looks for a "Book now" button; the button says "Book room" |
| `new-booking-row.spec.ts` | Flaky: every other run checks the table before it has refreshed |
