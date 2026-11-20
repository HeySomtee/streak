'use strict';
// Explicit routing command. Uses public loopback reads; never loads .env or signing keys.
const { existsSync } = require('node:fs');
const { isAbsolute, resolve } = require('node:path');
const { OperatorJournal, OperatorBusyError } = require('../dist/modules/direct/journal.js');
const { DirectRegistry, V4_DIRECT_CONFIG } = require('../dist/modules/direct/registry.js');
const { orderConfig } = require('../dist/modules/direct/order-config.js');
const { provisioningCatalogueUrl } = require('../dist/modules/direct/provision.js');
const {
  readMarketRollovers,
  readLegacyCampaignReservations,
  commitMarketRollovers,
  parseMarketRolloverArgs,
  runMarketRollover,
} = require('../dist/modules/direct/market-rollover.js');

async function readPublicJson(url) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8_000);
  try {
    const response = await fetch(url, {
      redirect: 'error',
      cache: 'no-store',
      signal: abort.signal,
    });
    if (!response.ok || !response.body) throw Error('Unavailable loopback API');
    const parts = [];
    let bytes = 0;
    for await (const part of response.body) {
      bytes += part.byteLength;
      if (bytes > 2_000_000) {
        abort.abort();
        throw Error('Loopback response exceeds its bound');
      }
      parts.push(Buffer.from(part));
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw Error('The live loopback API could not be verified. No rollover was written.');
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  parseMarketRolloverArgs(args);
  const directory = process.env.STREAK_DIRECT_OPERATOR_DIR;
  const orderDirectory = process.env.STREAK_ORDER_REGISTRY_DIR;
  const earlierPaths = [
    process.env.STREAK_DIRECT_REGISTRY_DIR,
    process.env.STREAK_DIRECT_BATCH_REGISTRY_DIR,
    process.env.STREAK_DIRECT_LEGACY_REGISTRY_DIR,
  ];
  if (
    !directory ||
    !orderDirectory ||
    !earlierPaths[0] ||
    !earlierPaths[1] ||
    [directory, orderDirectory, ...earlierPaths.filter(Boolean)].some(
      (path) => !isAbsolute(path),
    ) ||
    new Set(
      [directory, orderDirectory, ...earlierPaths.filter(Boolean)].map((path) => resolve(path)),
    ).size !==
      2 + earlierPaths.filter(Boolean).length ||
    !existsSync(directory)
  )
    throw Error(
      'Use the existing, separate absolute operator, earlier and v5 registry directories.',
    );
  if (process.env.NODE_ENV === 'production' && process.env.STREAK_DIRECT_DURABLE_STATE_ACK !== '1')
    throw Error('Durable operator storage must be acknowledged.');
  const port = process.env.PORT || '10000';
  if (!/^[0-9]{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw Error('Use a valid hosted API port.');
  const catalogueUrl = provisioningCatalogueUrl(
    process.env.STREAK_DIRECT_CATALOGUE_URL || `http://127.0.0.1:${port}/api/direct/fixtures`,
  );
  const configurationUrl = new URL('/api/direct/orders/configuration', catalogueUrl).toString();
  const config = orderConfig();
  const earlier = [
    new DirectRegistry(earlierPaths[0]),
    new DirectRegistry(earlierPaths[1], V4_DIRECT_CONFIG),
    ...(earlierPaths[2] ? [new DirectRegistry(earlierPaths[2])] : []),
  ];
  const queued = new DirectRegistry(orderDirectory, config);
  const journal = new OperatorJournal(directory, undefined, 10_000);
  const result = await runMarketRollover(args, {
    async load() {
      const results = await Promise.allSettled([
        readPublicJson(catalogueUrl),
        readPublicJson(configurationUrl),
      ]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      return {
        now: Date.now(),
        catalogue: results[0].value,
        configuration: results[1].value,
        localConfig: config,
        earlier: earlier.flatMap((registry) => registry.all()),
        queued: queued.all(),
        committed: readMarketRollovers(orderDirectory),
        legacyCampaignReservations: readLegacyCampaignReservations(orderDirectory),
      };
    },
    exclusive: (work) => journal.exclusive(work),
    commit: (ids) => commitMarketRollovers(orderDirectory, ids),
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error(
    error instanceof OperatorBusyError
      ? 'The operator is busy. No rollover was written. Retain its lock and retry later.'
      : error instanceof Error
        ? error.message
        : 'Market rollover did not complete. Retain existing records and review before retrying.',
  );
  process.exitCode = 1;
});
