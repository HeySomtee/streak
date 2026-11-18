# Regular new-market signed payments

18 November 2026. Local implementation and isolated verification. No Render
access, production database access or public fund movement. The previous
competition-only activation release was published as `b62633b`; it did not route
ordinary uncreated fixtures through the signed queue.

## Corrected journey

Regular picks on a new fixture use v5 when its verified deployment is configured.
Review prepares one immutable market description shared by both wallets. It does
not require the first wallet's confirmation. Each wallet signs its own funding
transaction, using its own inputs. Durable server acceptance precedes the receipt;
the existing recovery process creates the market and admits the orders without
another wallet action. Confirmation remains distinct from acceptance.

A slip can prepare up to eight new markets in one genesis transaction. Separate
new slips can reserve independent operator cells or a maximum of three dependent
setup batches using exact planned change. This is bounded concurrency, not a
promise of unlimited throughput. Existing v4 positions, active older reviews and
published competition pins keep their original flow. Mixed generations still
require separate slips. No chain migration or new script deployment is needed.

## Durable setup and recovery

`genesis-plans-v5` contains unsigned plans with five-minute renewable leases.
Three active unsigned plans per originating wallet and 128 globally bound
preparation. Unexpired descendants retain their ancestors. Accepted orders pin
their exact plans until the order's on-chain expiry, regardless of browser state.
The user must receive server acceptance before relying on unattended processing.

The server validates the exact plan under the operator lease before saving the
owner signature. Only funded orders trigger signing and journaling of genesis.
Signed genesis inputs remain protected indefinitely; expired unsigned previews
release their reservations. A crash never causes a different market hash to be
substituted under an accepted order. Signed parents prepared by the older CLI
remain recoverable, even without a corresponding preview plan.

Creation and admission still need canonical confirmation. Failed or unavailable
setup cannot prevent the order's expiry refund. Refunds become eligible at the
order's earliest selected kickoff, not immediately when a dependency fails. A
later fixture can depend on a setup batch containing an earlier fixture; if that
ancestor misses its creation deadline, the later order waits for its own expiry
refund. Parent creation can also fund an otherwise unused preview market. Each
created market needs about 3,050 tCKB of operator reserve, separate from user stakes.

CLI competition provisioning cannot create a second genesis while an active plan
holds the fixture. Operator lifecycle, older sponsor payments and owner order
selection all exclude reserved setup inputs. An unsigned preview does not trigger
the old global funding barrier; independent signed v5 genesis does not block
unrelated operator transactions. Confirmed change is rechecked live before use.

## Focused local evidence

- Actual native v5 scripts on an owned disposable CKB node: two distinct wallets
  sign before either payment or market confirms; one three-market genesis and
  both admissions complete after reconstructing the server. Three checks passed.
- Synthetic service integration: shared new-market setup, independent signed
  funding, multi-market genesis, bounded dependencies and restart completion.
- Recovery checks: three-plan promotion, ancestor retention, expired preview
  release, unrelated lifecycle barrier availability, and funded expiry refund
  without invoking market setup. Terminal unsigned plans no longer consume quota.
- Chromium at 390px using actual `PaymentCheckout`: new regular picks enter the
  sign-once review, three payments are accepted, a lost receipt is recovered,
  new picks remain possible and history survives browser closure.
- Independent money/recovery review found and prompted fixes for abandoned
  signed setup, legacy funding selection, spent change, ancestry boundaries,
  unsigned historical retention and the provisioning race. Final read-only
  review found no remaining concrete blocker in the scoped changes.

Backend/frontend TypeScript, scoped checkout ESLint, the production frontend
build, static policies and diff whitespace checks pass. The repository-wide
formatting command stops on the owner-edited
`hosted-acceptance-2026-11-06.md`; that unrelated checklist is preserved.
No full release-gate pass is claimed.

These checks are isolated, not physical MetaMask/Zerion or hosted acceptance.
The owner requested publication after these results and the deferred full gate
were disclosed. The full release gate remains deferred; commit/push hooks are
not evidence of verification for this publication. Hosted physical-wallet
acceptance remains outstanding. Publication alone does not verify deployment.
