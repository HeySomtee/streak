# Fresh payment timing correction

18 November 2026. Base revision: `70d7b89`.

## Evidence

The owner reported new signatures ending in Not Paid after the earlier recovery
release. The latest two hosted receipts are cancelled with neither an accepted
owner signature nor a sponsor signature. This establishes non-acceptance, not
which individual request or validation stage first failed.

A synthetic reproduction persisted a valid wallet signature after a 91-second
approval, then refused its first delivery because the offer had expired. A second
probe showed slow validation could open the wallet after the local review expired.
Neither reproduction used a live wallet, provider credential or production database.

## Changes

- Give new atomic offers five minutes after initial validation, capped at two
  minutes before match cutoff. Existing offers and repeat request deadlines stay
  unchanged. This is a maximum reservation window, not an added processing delay.
- Check review expiry again after validation and before the wallet prompt.
- Check only relevant historical inputs/fixtures for a fixed review. Remove the
  repeated historical chain scan after wallet approval, while retaining the wallet
  lock, identity check and atomic cross-store reservation checks on journal save.
- Deliver the saved signature before broad query invalidation starts more recovery
  work. Hide the obsolete discard action on an already rejected payment.

## Verification and release boundary

All 27 focused client tests, the isolated backend batch suite, and backend/frontend
TypeScript checks passed. Regressions cover 95-second wallet approval, exact signed
bytes delivered once, unrelated history isolation, expiry before prompting, a full
review window after slow server validation and unchanged idempotent deadlines.
Independent money/recovery review found no concrete safety blocker.

The owner explicitly deferred the long release suite until there is a working
hosted version. The earlier 105-stage pass applies to the previous release, not this
patch. Quick static policies and the production frontend build also passed. Automatic approval review initially blocked skipping the hooks. The owner then
explicitly approved skipping the full-suite commit and push hooks for this release
only. Publication uses that exception; no persistent hook configuration or quality
receipt is changed.

Hosted wallet acceptance remains required. Existing recovery work, operator
contention, failed validation or outages can still prevent acceptance. No old
signature is renewed or rewritten, and no payment is labelled confirmed without
chain evidence. Preserve the owner's unrelated acceptance checklist.
