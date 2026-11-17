# Streak queued prediction scripts v5

Local implementation only. No public deployment is recorded in the build manifest.
Historical v1 through v4 markets keep their original scripts and claims.

## Two stages, one wallet approval

1. The wallet signs a funding transaction creating one **order cell** and its own
   change. Its inputs do not include market lanes or sponsor funds.
2. The server saves those exact signed bytes before acknowledging acceptance.
   The existing operator then funds the order and admits its entire slip when
   the required market lanes become available. The browser can close.

The order lock and market type script share one binary. Market arguments remain
172 bytes with the v4 layout. Order lock arguments are `05 || hashCkb(orderData)`.
Empty markets must be created before accepting orders; no old pool is migrated.

## Order cell data

| Field               | Encoding and purpose                                             |
| ------------------- | ---------------------------------------------------------------- |
| Version, count      | One byte each; version 1, between 1 and 8 distinct markets       |
| Owner length, owner | Two-byte little-endian length, then the Molecule lock script     |
| Expiry              | Eight-byte little-endian milliseconds; earliest selected kickoff |
| Competition digest  | SHA-256 of the exact selection JSON; binds application choices   |
| Prediction lines    | Market type hash (32), cutoff (8), outcome (1), principal (8)    |

The order holds each prediction's principal and 321 CKB claim storage, plus a
101 CKB queue reserve. Admission returns that reserve to the exact owner lock,
less at most 1 CKB execution fee. Funding has a separately reviewed network fee.

Admission consumes the order at input zero and one lane per market. Every line
must match the signed market, outcome, amount and owner. Partial execution is
invalid. At expiry, anyone may instead spend the order into a single plain owner
output, retaining at most 1 CKB as a network fee. Consensus enforces the refund's
absolute timestamp `since` condition. Neither operator discretion nor a database
record can redirect the funds.

An admission transaction cannot know its future block timestamp. Existing later
header checks admit timely tickets and refund late ones. Queue acceptance means
durable authorization, not guaranteed market entry or competition points.

## Bounds and verification

Four lanes and eight positions per lane remain unchanged. The application admits
up to three pending payments per wallet and three concurrent executions. Known
wallet change chains are bounded, and their parent funding confirms before the
child is broadcast. Independent wallets can fund concurrently.

The VM suite retains market conservation, close, claim, replay and late-ticket
tests and adds order authorization/refund attacks. The signed disposable-node
journey covers three same-wallet approvals, restart, eight-market admission,
EVM expiry refund, consumed market dependencies, settlement and existing claims.
The hashes in [build-manifest.json](build-manifest.json) pin the reviewed local build.
These tests are not a public audit or hosted wallet acceptance.
