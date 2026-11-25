# Payment notification dismissal

24 November 2026. Local implementation; not published or deployed.

Queued-payment history recreated its latest confirmation after navigation or
reload because dismissal existed only in component state. Its presentation key
also included the temporary wallet revision. The inline confirmation path could
resurface a hidden notification after remount.

Terminal notification dismissals now persist in browser preferences, scoped to
the account, payment kind, payment ID and result. Both queued and atomic checkout
use the same subscription so duplicate mounted views and other tabs observe
dismissal. Wallet reconnection does not change the persisted key. Suppression
covers both the floating tracker and the inline slip confirmation. A new payment
or a different result still gets its own notification.

Pending payments bypass dismissal. Preparation errors and unsigned reviews use
temporary, attempt-specific dismissal rather than durable receipt preferences.
No signed journal, input reservation, server state, receipt or Activity entry is
deleted or changed by dismissal. Monitoring continues independently.

Preferences retain up to 1,000 dismissal keys on this browser origin. They do not
sync to another device. If browser storage is blocked, dismissal lasts for the
current document only. No private signatures or receiving addresses are stored
in these preferences.

Independent source review caught and resolved accidental persistence of
unsigned review/error dismissal. The final review found no blocking issue.
The browser run also exposed an existing offer-timing race: separate clock reads
could make expiry exceed the validator's two-minute bound by a millisecond.
Preparation now samples one timestamp for both values, preserving the existing
market-cutoff cap. The browser fixture advances every clock read to exercise this
boundary deterministically; independent review approved the correction.
Unit coverage verifies restoration, account/payment/result separation, tab
updates and blocked/malformed storage. Browser coverage uses synthetic payment
status projections and checks dismissal, component remount, document reload,
wallet reconnection, pending recovery visibility and a new receipt. Local gate
results are recorded in the work tracker; this is not hosted wallet acceptance.

## Verification outcome

Three new preference unit tests passed. Strict frontend TypeScript, hook lint,
repository policy checks and the production build passed. The final browser run
passed Chromium and WebKit at 390 and 1440px, including the advancing-clock
regression. Independent review approved both changes.

The full gate was attempted. After correcting formatting, static/build and the
completed backend/payment/concurrency checks passed. The run was intentionally
stopped during hosted-drain regression to complete focused verification; it is
not a full release pass. Remaining release lanes must pass before ordinary
commit/push publication. No hosted deployment or physical-wallet test was done.

The publication retry reached the full application checkout lane and exposed an
obsolete assertion that a dismissed inline success notice should return after
canonical recovery. The scenario now requires that notice to remain absent,
while retaining the exact persisted block/hash and no-duplicate-payment checks
and explicitly opening the confirmed Activity receipt. Independent review
approved this correction. The complete release gate must pass on this revision.

25 November follow-up also hides rehearsal competitions from guest and non-admin
competition lists. The shared list feeds public discovery, navigation and slip
choices. Administrators still see rehearsals, and direct-link receipt/history
access retains its existing rules. No competition or payment record is deleted.
The isolated HTTP regression verifies real competitions remain listed, rehearsals
stay absent after registration, and administrators retain both kinds.

25 November release exception: the owner explicitly requested "skip remaining
checks" after focused payment, campaign HTTP, Five and Survivor browser coverage
and independent review passed. The latest full run was stopped during competition
browser coverage at that request. It is incomplete, not a full-suite pass.
Publication to HeySomtee/streak uses a per-command commit/push hook bypass for
this release only. Production deployment must be verified separately.
