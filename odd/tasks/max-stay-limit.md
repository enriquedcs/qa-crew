# max-stay-limit: limit a single booking to 14 nights

Branch `feat/max-stay-limit` off `main`. Runner: `npm test` (Playwright). Test-first: one RED test per requested rule, then GREEN.
QA lens (Agentic QA, Chapter 4): every spec names its oracle, every task names its evidence, and exploration is a task, not an afterthought.

## Specs

- S1 Limit (user, verbatim L1): "No booking can be longer than 14 nights." Rule: a stay of 15 nights or more is rejected by the API with the error "stay cannot be longer than 14 nights"; nothing is stored. Oracle: HTTP 400, the exact error string, and an unchanged list of bookings.
- S2 Boundary: a stay of exactly 14 nights is accepted. Oracle: HTTP 201 and the booking in the list. Risk: off-by-one between nights and days.
- S3 Same rule in the UI (user, verbatim L3): "The form should say it before I press the button." Rule: choosing dates more than 14 nights apart shows "Stays are limited to 14 nights." and does not submit. Oracle: the status message, and no POST request sent.
- S4 Unchanged: existing bookings longer than 14 nights (if any) remain visible and cancellable. Oracle: the existing list and cancel tests stay green.

## Tasks

- [ ] T1 S1-S2 RED API tests for 14 and 15 nights, tagged `@max-stay-limit:S1` and `@max-stay-limit:S2`, then the validation rule (route: inline) — evidence: test names and run id — commit: pending
- [ ] T2 S3 RED UI test, then the form check (route: inline) — evidence: test name and trace — commit: pending
- [ ] T3 S4 run the baseline and spec suites unchanged (route: inline) — evidence: run id — commit: pending
- [ ] T4 S1-S3 exploratory charter, 20 minutes: "Explore stay lengths around the limit with month ends, leap days and back-to-back stays to discover off-by-one errors." (route: exploratory agent or human) — evidence: session notes — commit: n/a

## Log

- L1 2026-10-22 user (verbatim): > No booking can be longer than 14 nights.
- L2 2026-10-22 explored: validation lives in `src/app/validation.ts`; the UI form already checks capacity client-side, so S3 follows the same pattern. Tests for stay length do not exist yet.
- L3 2026-10-22 user (verbatim): > The form should say it before I press the button.
- L4 2026-10-22 open question for the product owner: does the limit count nights (check-out minus check-in) or calendar days? Assumed nights, as in S1; confirm before T1 is checked off.
