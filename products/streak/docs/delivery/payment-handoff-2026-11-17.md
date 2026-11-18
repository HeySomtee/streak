# Signed-payment handoff and recovery

17 November 2026. Base revision: `930c413`. This is local implementation evidence;
publication, Render deployment and physical-wallet acceptance are separate.

## Problem and correction

A transaction hash exists as soon as Streak builds a transaction. It does not prove
that a node received it. Public RPC reported no transaction body for the owner's
reported hash `0xe712591a4fce2532fe68765375950210ed51876cc4173dd46f4134cc0faef0a9`.
The private hosted receipt was not inspected, so its individual cause is unproven.

Source review found two avoidable dependencies: browser recovery read chain state
before delivering an already saved signature, and sponsor status reads competed
for the operator lease and remote RPC. The corrected flow is:

1. Save the exact wallet-signed bytes locally before delivery.
2. Deliver those bytes without waiting on unrelated historical chain reads.
3. Validate owner witness, frozen transaction and expiry, then persist the owner
   signature and flush its receipt before acknowledging acceptance.
4. Wake the existing operator to co-sign and broadcast. It continues after the
   browser closes; repeated requests reuse the same authorization.
5. Read the saved receipt without chain RPC or the operation lease. Retry lost
   delivery with bounded backoff, or recover a lost acknowledgement from the
   receipt. Show an explorer link only after observed network submission.

Before server acknowledgement, the UI asks the user to keep Streak open. After
acknowledgement it says processing continues automatically. Uncertain chain state
never becomes a fabricated confirmation, refund or released input.

## Expired payments and fresh reviews

The authenticated rejection action cannot sign or broadcast. Under the operator
lease it checks all retained offers with the same raw hash and their signed funding
operations. Only when no signature was accepted or operation signed does it
permanently cancel the unsigned aliases and return explicit rejection evidence.
The browser retains the original signature and attempt timestamp, marks the payment
not accepted and releases its local reservation. An expired offer alone is not
sufficient. Later canonical chain evidence still takes precedence.

A fresh review cannot reuse a retired transaction hash. If its unsigned transaction
would collide, its quoted fee increases by one shannon at a time until unique,
within existing fee and minimum-change limits. This happens before wallet review;
no previously signed bytes or sponsor contribution change. Retrying the same
request identity still returns exactly its original offer.

Competition payment-start checks remain in submit and resume. Failure of later
receipt bookkeeping cannot turn an accepted payment into an API failure; the
existing observation/recovery path retries bookkeeping.

## Readiness and limits

Render logs showed sponsor startup readiness timing out, then completing later.
Readiness now uses an authenticated local health endpoint instead of RPC-dependent
batch configuration. It remains available when all four operation slots are busy.
Configured code verification still runs before the listener opens; a sufficiently
slow pre-listen RPC can exceed the unchanged startup budget.

This does not increase v4 market capacity or prove v5 market activation. It adds
no worker and moves no hosted funds. Initial acceptance still depends on valid
inputs, an unexpired review, the operator, database and required verification RPC.
Permanent node rejection or genuine competing spends retain conservative recovery.

## Verification

- Strict backend and frontend TypeScript passed.
- All 25 isolated browser-client tests passed, including lost delivery, lost
  acknowledgement, reload, expiry, duplicate-hash ambiguity and RPC failures.
- The isolated backend batch suite passed, including acknowledgement before
  co-signing, status reads during lease/slot contention, expiry during validation,
  duplicate cancellation, restart recovery and distinct fresh review hashes.
- The 15 host lifecycle regressions passed during readiness investigation.
- Independent money/recovery review found no concrete blocker in the final scope.
  The reviewer inspected code and tests; it did not perform a live transaction.
- All four integrated Chromium/WebKit desktop/mobile journeys passed.
- The complete release gate passed all 105 stages on Node 24.14.0, finishing
  17 November at 20:08:11 UTC. The exact-tree receipt covers
  `5d2994be8f0922a50c032f44590c3da9b801eac1`. Earlier interrupted verification
  and the failed first attempt are not passing evidence.

All routine checks use synthetic identities, isolated transports or disposable
local services. Physical MetaMask/Zerion and hosted recovery remain to verify.

The first complete-gate attempt stopped at a timing-sensitive browser assertion
that still expected one POST after automatic retries were enabled. The fixture
now validates every attempt against the immutable saved offer, hash and signature,
including failed attempts. Deterministic client tests retain the backoff assertions;
browser tests require automatic recovery with no further wallet prompt. The failed
run is retained in local evidence and is not a passing release gate.

## Publication and public verification

18 November: published as [ecf5b26](https://github.com/HeySomtee/streak/commit/ecf5b26caf219ac2e99095bebf4eac7e44bc942e).
Commit and push reused the successful full-gate receipt for the exact tree.
Hosted CI remains paused. The public Season page returned HTTP 200 and served
`index-C8kdwk10.js`, `batch-client-uQoD6p4b.js` and `batch-ui-Rq1bgeno.js`; all
three downloaded assets matched the verified local build byte-for-byte. This
establishes public frontend publication, not physical-wallet or backend payment
acceptance. The original reported payment has not been declared recovered.

Local evidence is retained in `.quality-artifacts/all.json`, the exact-tree hook
receipt and `.quality-artifacts/payment-handoff-2026-11-17/`. The first failed
attempt is preserved separately. The owner's unrelated acceptance checklist is
restored after publication and is not included in this release.
