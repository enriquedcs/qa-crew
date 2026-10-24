# BUG-0023: Cancelling with a stale page cancelled someone else's booking

- **Severity:** medium
- **Area:** cancellation, data integrity
- **Found by:** exploratory testing
- **Status:** fixed (2026-07)

After a data reset, booking ids started again from b1. A guest with an old page
open clicked "Cancel" and deleted a new booking that reused the same id.

**Root cause:** predictable, reused ids, and no check that the booking belonged to
the person cancelling it.

**Lesson:** cancellation needs an ownership check, and ids must not be reused.
