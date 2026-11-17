# Queued payments release and activation

17 November 2026. Local release tooling. Public activation and physical-wallet
acceptance must be recorded separately.

## What ships

The v5 queue lets a wallet sign up to three pending slips. After **Saved for
processing**, the server owns execution and recovery even if the browser closes.
Existing v4 markets retain their original flow. Do not mix v4 and v5 fixtures in
one campaign slip. Each v5 market still has four lanes and 32 positions.

Recovery performs remote reads outside the shared payment lock. Short writes
compare the saved order with the original snapshot and recheck input reservations,
execution slots, expiry and lifecycle priority before committing. Stale work is
abandoned. Preparation/submission still contain foreground network reads; this is
not a guarantee of instant acceptance under every RPC failure.

## Operator deployment

Use the existing Render service, persistent disk, operator journal and registry.
Do not create a second signer with a separate copy of the journal. Retain the
existing database and all environment settings when reconnecting the repository.
Leave both `STREAK_ORDER_PROTOCOL_TX_HASH` and `STREAK_ORDER_REGISTRY_DIR` unset
until the new code deployment is confirmed.

The reviewed protocol binary is packaged at
`products/streak/contracts/direct-v5/deployment/streak-protocol-v5`. Its hash and
47,880-byte size must match `build-manifest.json`; the Rust gate rebuilds it and
compares the exact bytes. The CLI verifies the hash again before preparation.
No Rust installation is needed in the hosted runtime.

Run in the service's Shell, where its existing operator environment is available:

```bash
node products/streak/scripts/direct-deploy-order.cjs prepare
```

This signs and durably records the deployment but does not broadcast. Review the
printed transaction hash and capacity. A standard native lock needs **47,941 tCKB**
for the code cell, plus valid wallet change and network fees. The command reports
actual required capacity if funding is insufficient and combines confirmed,
unreserved plain cells from a bounded collection. It never reads key files or
prints signatures. Stop and reconcile a busy operator before retrying.

```bash
node products/streak/scripts/direct-deploy-order.cjs broadcast
node products/streak/scripts/direct-deploy-order.cjs status
```

Keep `deployment-v5.json` in the original operator directory. Repeating preparation
returns the same authorization; broadcast only resends those exact bytes when
all inputs remain live. Unknown, rejected or conflicting outcomes require review,
not deleting the record and signing another transaction. Wait for committed status
with at least four confirmations.

Then configure together, using the confirmed deployment hash:

```text
STREAK_ORDER_PROTOCOL_TX_HASH=<confirmed transaction hash>
STREAK_ORDER_REGISTRY_DIR=/var/data/streak/registry-v5
```

The service verifies live pinned code and canonical confirmation before exposing
queued payments. Existing registries stay in place. New queued markets must be
pre-created with the existing operator command:

```bash
node products/streak/scripts/direct-operator.cjs create FIXTURE_ID --queued
node products/streak/scripts/direct-operator.cjs create FIXTURE_ID --queued --broadcast
node products/streak/scripts/direct-operator.cjs reconcile FIXTURE_ID --queued
```

Choose fixtures with no existing older-generation market. Review each market's
funding before broadcast. Do not enable a campaign until every selected fixture
has its confirmed v5 descriptor. Never clear order settings or remove its registry
while accepted orders or claims still require recovery.

## Hosted acceptance before announcing

1. Use MetaMask and Zerion with funded test accounts. Verify sign-in and switching.
2. Sign three slips, including two for the same market. Start the next draft while
   they process. Leave only after each says **Saved for processing**.
3. Close the browser, reopen, and verify the same payments without another signature.
4. Confirm competition picks count once and regular-only picks do not score.
5. Check finalization, winner export and prize display in rehearsals before opening
   the real Five and Predictions competitions. Survivor is outside this campaign.

Mainnet campaign prizes remain separate organizer-wallet transfers. Testnet
predictions and testnet settlement do not pay those mainnet awards automatically.
