# Queue activation and payment receipts

18 November release direction: the owner requested "push skip tests" for this
release. Commit and push hooks are skipped for this publication only; no tests
are rerun. Earlier focused evidence remains recorded, and the full release gate
and hosted physical-wallet acceptance remain outstanding.

18 November 2026. Local implementation, not hosted activation. No Render access
or public funding was performed. Existing v4 markets retain their payment rules.

## New competition markets

Publishing a prediction competition pins eligible, uncreated fixtures to v5 when
its deployment is configured. The signer reserves that generation under its
existing operator lease before the database publishes the competition. Existing
registries, signed creations and live legacy offers prevent conflicting versions.
Only published, nondeleted competitions with future v5 fixtures enter the automatic
provisioning scope. Ordinary browsing does not authorize funding every fixture.

The existing worker reads a bounded metadata-only query through the loopback API,
cached for 30 seconds. It creates and reconciles markets with the existing durable
journal and canonical confirmation checks. No additional worker or database access
for the signer is introduced. Each market needs approximately 3,050 tCKB of reserve;
funding limits and older pending operations can delay opening. Setup is separate
from a user's signed payment queue. Checkout shows that distinction and cannot
silently fall back to the older flow when configuration or database reads fail.

An interrupted publication can leave a generation commitment without a published
competition. This does not authorize spending. Checkout displays unfinished setup;
the administrator can retry publishing the competition with the same fixtures.
The existing explicit `create FIXTURE_ID --queued --broadcast` operator path is
also available for reviewed manual setup, followed by reconciliation. Do not delete
commitment files or replace older markets to force a version change. Deletion stops
future provisioning after cache refresh; already signed work keeps its recovery path.
A failed setup that passes kickoff remains unresolved for review rather than
inventing an absence proof or declaring the competition finished.

## Completion and Activity

Clearing a paid slip previously unmounted its older payment monitor when v5 was
configured. Both monitors now remain mounted, with one visible tracker selected by
pending work first and then recency. Confirmation stays until dismissed, including
inside an open slip. Hidden legacy checkout does not poll its preparation endpoint.
Saved for processing remains distinct from confirmed placement on-chain.

Activity already received original deposit metadata, but its parser discarded it.
It now validates and preserves that metadata, shows Placed separately from Kickoff,
and sorts known placements by their timestamp. Settlement and claim transactions
do not replace the original placement time. Missing evidence is labelled unavailable
or awaiting confirmation; kickoff is never substituted for placement.

## Local evidence and remaining acceptance

- Backend and frontend strict TypeScript checks, static policy checks and the production frontend build passed.
- Activity: 15 tests passed, including retained placement time after a claim,
  malformed metadata rejection and older records without placement evidence.
- Campaign domain: 24 checks passed, including lazy v4/v5 canonical bindings.
- Provisioning and host regressions passed, including durable generation selection,
  earlier-generation conflict protection and signer/database isolation.
- Disposable local PostgreSQL passed publication preflight, selected-fixture scope,
  failed-publication rollback and the existing campaign/entry regression checks.
- Chromium at 390px passed the synthetic combined-payment journey, empty-slip
  version change, retained tracker, inline confirmation and explicit dismissal.
  This is not physical-wallet or public-chain evidence.
- Independent money/recovery review found and prompted fixes for metadata shape,
  generation races, publication preflight and tracker priority/dismissal. Final read-only review found no additional concrete blocker.

The owner deferred the long release gate until a working version. Other browser
sizes/engines, hosted v5 market creation and three physical-wallet signed payments
continuing after browser closure remain outstanding for this revision. No claim
of a deployed or universally available queue is made.
