# Changelog

All notable changes to DayPilot are documented here.

## 2026-10-19 — v1.1.0

This release closes the gap between what the README claimed and what the code actually did.
No new features. Nothing about the evening review or the weekly report was advertised before
this release that had not already shipped — the fixes bring the implementation up to the claim.

### Fixed

**1. The evening review was validated outside the eval system.**

Review validation lived inline in `app.js`, checked only three things, ignored `diagnosis` and
length limits, and — critically — did **not** retry when the underlying call threw.
It has been moved into `js/eval.js` as `validateReview()`: score within 1–10, comment ≤120 chars,
diagnosis ≤120 chars, and at least two non-empty `suggestions`.

**2. The weekly report had no validation and no retry at all.**

`generateWeekly()` returned whatever came back. Added `validateWeekly()`: non-empty body of
30–400 characters. The live branch also returned `txt` instead of `txt && txt.report`, so a
malformed payload could surface as an object rather than the report string.

**3. An exception inside `generate` escaped the gate instead of counting as an attempt.**

`gate()` let a throwing `generate` bubble straight out, so a transient failure bypassed retry
entirely. `generate` throwing now counts as an attempt like any other failure.

**4. Retry classification was too coarse.**

Added `classifyError()` so the retry budget is spent only where retrying can help:

- **non-retriable** — `401` / `403` (authentication and permission): abort immediately,
  retrying cannot fix these
- **retriable** — `429`, `5xx`, network failures, and non-JSON responses: retry, and pass the
  failure reason back into the prompt so the model can correct itself

`generateReview()` and `generateWeekly()` now take an `attempt` argument for exactly this.

**5. `threshold: null` was not a documented, meaningful value.**

`threshold: null` now means *format gate only* — run the deterministic rule check, skip the
model-scoring layer. The review and weekly flows use it, which is why they were previously
outside the log. Both now appear in the Eval log (the weekly report is labelled 「📝 周报」).

### Added

- `_selftest_eval.js` — a Node self-test covering the gate, both validators, and the error
  classifier. 20 assertions, all passing. Run with `node _selftest_eval.js`.
- This `CHANGELOG.md`.

### Scope of the self-test (stated honestly)

The self-test exercises the **logic layer only**. It does not run in a browser and does not make
real LLM calls — those are stubbed. It proves the retry and validation rules behave as described
above; it does not prove end-to-end behaviour against a live model.

## 2026-09-24 — v1.0.0 (first tagged baseline)

Initial public release: morning planning, daytime check-off, evening AI review, weekly
completion board and weekly report, `.ics` export, and the LLM output evaluation pipeline.
