# Sign once, server-owned prediction queue

9 November 2026. Implementation and local verification complete; not published
or activated on public testnet. This replaces the earlier three-wallet-only
concurrency experience for newly created v5 markets.

## User journey

- Review exact picks, stake, storage, refundable queue reserve and funding fee.
- Sign once. Wait for **Saved for processing** before leaving the app.
- Start another slip immediately, up to three pending payments per wallet.
- Streak continues after browser closure or operator restart. It either places
  the complete slip or returns the order funds after expiry.
- An interrupted upload retries the same signature. A never-accepted expired
  review requires a conclusive server cancellation before local retirement.

An accepted queue entry is not yet a prediction in the market. Competition points
bind to the actual confirmed admission transaction, never the funding transaction.
Normal market deadline checks, settlement, storage returns and claims still apply.

## Implementation boundaries

The [v5 script](../../contracts/direct-v5/README.md) locks the exact owner, markets,
amounts and outcomes. Funding needs no sponsor cell or mutable market input.
Wallet change can fund the next signed order, with a bounded dependency chain.
The existing operator process owns durable funding, admission and refund recovery.
Acceptance wakes its existing recovery loop immediately.

An admission whose input or market-control dependency is demonstrably spent by a
canonical transaction can be retired and rebuilt. Unknown outcomes preserve the
original bytes and reservations. Reorg checks revisit completed records; historical
records are streamed rather than loaded together during recovery.
Conflict searches persist their page cursors across restarts. A fresh observation
revision distinguishes re-confirmation after a reorg. Scoring deliveries remain
unacknowledged until verified and saved; rotating delivery lets healthy events
progress even with more than one page of delayed observations. Verified refunds
and failed funding stop showing as pending in competitions without releasing the
original competition choice.

The server bounds pending orders at 128, each wallet at 3 and execution at 3.
The journal retains up to 4,096 records and 32 execution attempts per order. These
are pilot safety limits, not a capacity promise. Expansion and archival remain
separate reviewed work. Existing generations retain their routes and journals.

## Local evidence

- V5 VM: all 16 groups passed again in final verification.
- Signed local CKB: seven checks passed, including eight-market atomic entry,
  EVM refund without another approval, a spent control dependency and real claims.
- Chromium and WebKit, 390px and 1440px: three accepted slips, new picks while
  pending, lost acceptance response, fourth-payment limit, browser closure and
  operator recreation passed. These use synthetic wallet transport.
- Disposable PostgreSQL: competition execution binding rejects changed identities
  and outcomes, ignores unconfirmed execution, and replays without duplicate audits.
  The test exposed and fixed an audit-revision collision.
- Activity: five-generation lineage, settlement, claims and reorg regressions pass.
  Delivery regressions cover RPC lag, shallow/orphaned receipts, database failure,
  re-confirmation and a 71-event unacknowledged backlog.
- Independent money/recovery review covered order authorization, durable acceptance,
  reservations, conflict/reorg recovery and competition delivery. It identified the
  event-delivery, conflict-page, regular-only and refunded-entry issues above.
  Fixes and regressions are present; final source re-review found no concrete
  blocker. A known canonical conflict is revalidated directly, so a shifted
  history page cannot make a failed payment appear active again.

All **105 required stages** have passing evidence as of 9 November, 20:32 UTC,
across the major run and its continuations. This is combined evidence, not an
uninterrupted `quality:major` pass. The final recovery correction also passed the
unit suite, TypeScript, queue browser and signed-chain checks. Static checks,
lint and the production build passed again.

The run exposed old test fixtures pinned to IndexedDB v3 and missing the payment
configuration endpoint. Updated fixtures verify v4 migration and preserve the
original recovery assertions. A historical sponsored-browser error boundary did
not recur when rerun after the production build completed; all four journeys then
passed. The separate Five chain invocation initially lacked its disposable database
URL; both Five stages passed when supplied that explicit local test setting.
Failed reports are retained alongside the successful continuations under ignored
`.quality-artifacts/`; `order-combined-evidence.json` records each stage's source.

Remaining release work: publication, separate deployment and physical-wallet
acceptance. No production funds or provider credentials were used. Independent
review is local engineering evidence, not an external security audit.

## Activation is separate

Leave `STREAK_ORDER_PROTOCOL_TX_HASH` and `STREAK_ORDER_REGISTRY_DIR` unset until
deployment is approved. A configured deployment must match the pinned code hash,
be live and canonical with four confirmations, and use a distinct durable registry.
The host requires both settings together. Deploying code, funding empty v5 markets
and accepting physical MetaMask/Zerion payments are not established by local tests.
