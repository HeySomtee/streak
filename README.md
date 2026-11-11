# Streak

Your game. Your call. Football prediction markets settled on Nervos CKB, with
Streak Five fantasy football, Survivor and community competitions.

**Try it:** [streakpitch.com](https://streakpitch.com). Current prediction payments
use CKB Pudge testnet. Campaign prizes have their own published rules.

Wallet-signed predictions, settlement, refunds and claims use versioned CKB
scripts. PostgreSQL provides identity, competition scoring and fast Activity
views; the chain controls direct prediction funds.

## Start here

- [Application guide](products/streak/README.md)
- [Current delivery status](products/streak/status.md)
- [Documentation map](products/streak/docs/README.md)
- [Architecture](products/streak/docs/architecture/overview.md)
- [Latest public report](reports/week-23.md)
- [Repository migration and history](docs/repository-migration.md)

## Development

Use Node 24.14.0 and npm 11.9.0.

```sh
npm ci
npm run hooks:install
npm --prefix products/streak run build
npm start
```

Follow the [local setup guide](products/streak/README.md) for environment settings
and the operator processes needed for real payment testing. Never reuse production
keys or a production database in automated tests.

```sh
npm --prefix src/week13/vault-lock ci
npm run quality:major
```

The [quality guide](products/streak/docs/delivery/quality.md) describes disposable
PostgreSQL, browser and local CKB prerequisites. Hosted CI remains paused.

## Layout

- `products/streak/`: application, web UI, scripts, contracts and product docs.
- `scripts/quality/`: local checks and Git hooks.
- `src/week13/`, `src/week18/`, `src/week19/`, `src/week20/`: Streak's contract
  foundations, including shared client and devnet code still used by the app.
- `reports/`: public development reports and galleries.

The paths are intentionally retained during extraction so existing imports,
recovery tools and Render build/start commands continue to resolve.
