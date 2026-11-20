# Fresh markets for earlier payment fixtures

19 November 2026. Owner requested fresh v5 markets after a community tester
could not pay a slip containing v4 and v5 fixtures. This is an explicit testnet
entry rollover, not a rewrite of earlier positions or signed transactions.

## Behavior

The operator records selected fixture IDs in the v5 registry. New picks for
those fixtures use the sign-once queue, including slips mixed with other v5
fixtures. The existing worker creates the fresh markets. On-demand preparation
can share their immutable genesis before confirmation.

Earlier registries, signed payments, Activity and claim paths remain intact.
New unsigned reviews cannot enter the old pools after rollover. Payments already
accepted by the server finish using their original bytes and rules. A wallet
signature that was never accepted may require a fresh review. No old stake is
moved into a fresh pool, and old pool totals never price new entries.

A permanent marker survives restart and preview expiry. Its write uses the
existing operator lease. Explicit IDs, matching deployed testnet configuration,
fresh scheduled fixtures and unchanged kickoff are required. The command fails
closed if it cannot check published competition pins. No new contract deployment,
private-key file, database connection or separate worker is introduced.

Publication of an earlier-generation competition reserves its fixture IDs under
that same lease before writing published rules to the database. Rollover and
that reservation reject one another in either order. Failed publication retains
a conservative reservation; it is not automatically released. Existing published
competition pins remain protected. This relies on the existing single API writer
and operator deployment, not concurrent old/new application versions.

## Hosted operation

Deploy this code before running the command in the existing service environment.
Preview is read-only. Append `--apply` to commit the same reviewed fixture IDs.
The command queues work; a successful response does not prove chain deployment.

The read-only 19 November inventory found these 14 scheduled older fixtures.
All 20 current Opening Weekend competition fixtures already use v5 and are
excluded. Refresh the preview before applying because schedule/state can change.

```bash
node products/streak/scripts/direct-rollover-markets.cjs api-football-1575221 api-football-1557474 api-football-1550200 api-football-1575226 api-football-1575222 api-football-1575225 api-football-1557468 api-football-1557476 api-football-1557470 api-football-1557467 api-football-1552824 api-football-1550205 api-football-1570462 api-football-1557475
```

Each new market needs 3,050 tCKB of operator reserve. These 14 require 42,700 tCKB
plus fees and operator change. Existing reserved inputs remain unavailable for
new spending. The worker may wait for suitable confirmed funding. Repeating an
apply is idempotent and does not create duplicate market identities.

Verify `/api/direct/orders/configuration` no longer lists these IDs as legacy,
then verify their confirmed v5 records in `/api/direct/markets`. A new mixed
slip must show one queued-payment review. Separately confirm that old predictions
still appear in Activity and retain their original settlement/collection paths.
Do not delete registry files, signed journals or locks to force this operation.

## Verification state

20 November release [ed0d46e](https://github.com/HeySomtee/streak/commit/ed0d46eaaf5a4425c6137585766bdd488eba55b6) is published. All 110 required local
stages passed in one complete run, finished 06:37 UTC on Node 24.14.0. The exact
Git tree receipt was reused for push. This includes the mixed replacement-market
browser checkout, native queued-order chain lifecycle, older claims, real
PostgreSQL and both browser engines. At 06:42 UTC both public frontend bundles
matched the verified build and the new backend configuration was present.

The owner then ran the explicit hosted apply command for all 14 IDs above. Its
response was `queued`, with 14 new commitments, 14 awaiting market registration
and `broadcast: false`. At 06:47 UTC public configuration independently showed
all 14 absent from `legacyFixtureIds` and present in `reservedFixtureIds` and
`plannedFixtureIds`. No target yet appeared in the registered v5 market list.
Independent public review at 06:48 UTC found all 14 original markets still in
`/api/direct/markets`, with original creation transactions and
`entryEnabled: false`. This verifies new-entry routing
activation and retained original-market visibility, not completed fresh-pool
deployment or a hosted claim. The worker still has to register the fresh pools;
physical-wallet mixed-slip and earlier-claim acceptance remain outstanding.
The earlier attempts below are historical local evidence.

Focused isolated tests cover rollover commitments, both publication race orders,
rejected earlier unsigned reviews, retained accepted-signature recovery, fresh
pool selection and mixed-market checkout. The mobile Chromium journey uses the
actual checkout with synthetic transport: three two-pick payments are signed and
accepted, lost responses recover, and history survives browser closure.

Synthetic operator integration covers a funded earlier pool alongside fresh v5
markets and successful queued admission without altering the earlier cells.
Independent review found no remaining blocker after correcting the publication
race and internal proxy allowlist. Backend build, static policies, production
frontend build and isolated campaign PostgreSQL regressions pass.

`npm run quality:major` was attempted on 19 November. It stopped at formatting
in the owner's separately edited `hosted-acceptance-2026-11-06.md`, which was
preserved. No later lane in that run is counted as passed. Focused checks above
are separate evidence, not a full release receipt. Publication and activation
remain outstanding.
No live rollover, public chain funding, hosted deployment or physical-wallet
acceptance is claimed by this local implementation record.
