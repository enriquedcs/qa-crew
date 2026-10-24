# BUG-0019: Discount code limits enforced only in the browser

- **Severity:** high
- **Area:** validation, API
- **Found by:** security review
- **Status:** fixed (2026-05)

The checkout form refused expired discount codes, but the API accepted them. A
partner integration that called the API directly got discounts it should not have.

**Root cause:** the rule was implemented in the UI and never in the API.

**Lesson:** any rule the UI enforces must also be enforced, and tested, at the API.
Look for this pattern in every form with client-side checks.
