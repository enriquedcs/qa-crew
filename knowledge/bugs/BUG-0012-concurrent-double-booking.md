# BUG-0012: Two guests got the same room for the same night

- **Severity:** critical
- **Area:** availability, concurrency
- **Found by:** hotel staff, at the front desk
- **Status:** fixed (2026-02) for the single-server setup

Two booking requests for the same room and dates arrived within a few
milliseconds. Both passed the availability check before either was saved, so both
were confirmed.

**Root cause:** check-then-insert without a lock or a unique constraint.

**Lesson:** the overlap rule must hold under concurrent requests, not only for
requests sent one after another. A test that books sequentially cannot catch this.
