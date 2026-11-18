import { OrderMarkets } from './order-markets';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import * as ccc from '@ckb-ccc/core';
import { SponsorService, parseSponsorRequest, type SponsorSubmitRequest } from './sponsor';
import { BatchService, parseBatchRequest } from './batch';
import { sponsorId } from './sponsor-journal';
import {
  DirectRegistry,
  V3_DIRECT_CONFIG,
  V4_DIRECT_CONFIG,
  PUBLIC_DIRECT_CONFIG,
  PROVIDER_ORIGIN,
  object,
  hash32,
} from './registry';
import { OperatorBusyError, OperatorJournal } from './journal';
import { boundedJson, assertQueuedCreationAvailable } from './cli';
import { parseQueuedFixtureIds, commitQueuedFixtures } from './queued-fixtures';
import { provisioningCatalogueUrl } from './provision';
import { createFixtureReader } from './fixture-reader';
import { startHostedRecovery } from './hosted-drain';
import { ActivityEventOutbox } from '../activity/outbox';
import { readCampaignAbsence } from './campaign-absence';
import { ReviewWaitingError } from './review-queue';
import { OrderService } from './order-service';
import { orderConfig, verifyOrderDeployment } from './order-config';

function secret(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{64}$/.test(value))
    throw Error('Configure a separate 32-byte sponsor IPC secret');
  return value;
}
export function sponsorServiceUrl(value: string | undefined): string {
  if (!value) throw Error('Sponsor service is not configured');
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw Error('Sponsor service must use an explicit loopback HTTP port');
  return url.origin;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 220_000) throw Error('Sponsor request exceeds its byte limit');
    chunks.push(Buffer.from(chunk));
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')), 'sponsor request');
}
function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
/** Bound to loopback by the launcher. The API process has only this IPC credential. */
export function createSponsorServer(
  legacy: SponsorService,
  ipcSecret: string,
  batch?: BatchService,
  options: { campaignEmptyHistoryAcknowledged?: boolean; orders?: OrderService } = {},
) {
  const expected = Buffer.from(`Bearer ${secret(ipcSecret)}`);
  const activity = new ActivityEventOutbox(legacy.options.journal);
  let active = 0;
  const server = createServer(async (req, res) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply(res, 401, { error: 'Sponsor IPC authentication required.' });
    // Process readiness must not depend on chain reads or available payment slots.
    // The launcher still verifies configured queued code before opening this listener.
    if (req.url === '/health' && req.method === 'GET')
      return reply(res, 200, { service: 'streak-sponsor', ready: true, batchEnabled: !!batch });
    if (req.method === 'GET' && /^\/(batch\/)?status\?/.test(req.url ?? '')) {
      try {
        const url = new URL(req.url!, 'http://127.0.0.1');
        const service = url.pathname === '/batch/status' ? batch : legacy;
        if (!service) return reply(res, 409, { error: 'Payment service is not active.' });
        return reply(
          res,
          200,
          service.receipt({
            offerId: sponsorId(url.searchParams.get('offerId')),
            rawHash: hash32(url.searchParams.get('rawHash'), 'transaction hash'),
          }),
        );
      } catch {
        return reply(res, 409, {
          error: 'Saved payment receipt is unavailable. Keep the original payment.',
        });
      }
    }
    if (active >= 4)
      return reply(res, 429, {
        error: 'Sponsor queue is busy. Retry with the same request identity.',
        ...(req.url === '/batch/offer' ? { reviewWait: { position: 0 } } : {}),
      });
    active++;
    const startedAt = performance.now();
    let operation = 'unknown';
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname.startsWith('/orders/')) {
        operation = 'orders';
        const orders = options.orders;
        if (url.pathname === '/orders/configuration' && req.method === 'GET')
          return reply(res, 200, orders?.configuration() ?? { enabled: false });
        if (!orders) return reply(res, 409, { error: 'Queued payments are not active yet.' });
        if (req.method !== 'POST')
          return reply(res, 405, { error: 'Use a signed-in payment request.' });
        const payload = await body(req),
          owner = payload.authenticatedOwnerAddress,
          request = object(payload.request, 'order request');
        // Internal API-to-signer operation only; no public route exposes this.
        // CampaignService verifies administrator access and draft terms first.
        if (url.pathname === '/orders/reserve-markets') {
          const ids = parseQueuedFixtureIds(request.fixtureIds);
          await legacy.options.journal.exclusive(async () => {
            const registries = [
              legacy.options.registry,
              ...(batch ? [batch.options.registry] : []),
              ...(batch?.options.existingRegistry ?? []).filter(
                (r) => r.config.protocolHash !== orders.options.config.protocolHash,
              ),
            ];
            for (const id of ids) {
              if (!orders.options.registry.get(id))
                assertQueuedCreationAvailable(
                  id,
                  legacy.options.journal,
                  registries,
                  orders.options.config.protocolHash,
                );
            }
            commitQueuedFixtures(legacy.options.journal.directory, ids);
          });
          return reply(res, 200, { reserved: ids });
        }
        if (typeof owner !== 'string' || owner.length > 300)
          throw Error('Authenticated wallet required');
        if (url.pathname === '/orders/prepare-markets') {
          if (!orders.options.marketPreparation)
            throw Error('On-demand market preparation is unavailable');
          return reply(res, 200, {
            markets: await orders.options.marketPreparation.prepare(request.fixtureIds, owner),
          });
        }
        if (url.pathname === '/orders/wallet') return reply(res, 200, await orders.wallet(owner));
        if (url.pathname === '/orders/offer') {
          if (request.ownerAddress !== owner)
            return reply(res, 403, { error: 'Use the wallet linked to the signed-in account.' });
          return reply(res, 200, await orders.prepare(request));
        }
        const id = sponsorId(request.offerId);
        if (url.pathname === '/orders/status') return reply(res, 200, orders.status(id, owner));
        if (url.pathname === '/orders/cancel-review')
          return reply(res, 200, await orders.cancel(id, owner));
        if (url.pathname === '/orders/submit' && typeof request.userSignedBytes === 'string') {
          const accepted = await orders.submit(id, owner, request.userSignedBytes);
          reply(res, 200, accepted);
          server.emit('payment-accepted');
          return;
        }
        return reply(res, 404, { error: 'Unknown queued-payment operation.' });
      }
      if (url.pathname === '/campaign/absence') {
        operation = 'campaign-absence';
        if (req.method !== 'POST' || !batch || options.campaignEmptyHistoryAcknowledged !== true)
          return reply(res, 409, { error: 'Campaign operator verification is unavailable.' });
        const payload = await body(req);
        return reply(res, 200, await readCampaignAbsence(batch, payload.request));
      }
      if (url.pathname.startsWith('/activity/')) {
        operation = 'activity';
        if (req.method === 'GET' && url.pathname === '/activity/events')
          return reply(res, 200, activity.read());
        if (req.method === 'POST' && url.pathname === '/activity/ack') {
          const payload = await body(req);
          return reply(res, 200, { acknowledged: activity.acknowledge(payload.request) });
        }
        return reply(res, 404, { error: 'Unknown activity relay operation.' });
      }
      const atomic = url.pathname.startsWith('/batch/');
      const service = atomic ? batch : legacy;
      if (!service)
        return reply(res, 409, {
          error: 'Atomic payment is awaiting its verified deployment and operator activation.',
        });
      if (atomic) url.pathname = url.pathname.slice(6);
      if (
        [
          '/configuration',
          '/fixture',
          '/status',
          '/offer',
          '/submit',
          '/resolve',
          '/reject',
          '/resume',
          '/cancel-review',
        ].includes(url.pathname)
      )
        operation = url.pathname.slice(1);
      if (req.method === 'GET' && url.pathname === '/configuration')
        return reply(res, 200, await service.configuration());
      if (req.method === 'GET' && url.pathname === '/fixture') {
        const id = url.searchParams.get('fixtureId');
        if (!id || !/^api-football-[1-9][0-9]{0,14}$/.test(id)) throw Error('Invalid fixture');
        return reply(res, 200, await service.describe(id));
      }
      if (req.method === 'GET' && url.pathname === '/status')
        return reply(
          res,
          200,
          await service.status(
            {
              offerId: sponsorId(url.searchParams.get('offerId')),
              rawHash: hash32(url.searchParams.get('rawHash'), 'transaction hash'),
            },
            false,
          ),
        );
      if (
        req.method !== 'POST' ||
        !['/offer', '/submit', '/resolve', '/resume', '/reject', '/cancel-review'].includes(
          url.pathname,
        )
      )
        return reply(res, 404, { error: 'Unknown sponsor operation.' });
      const payload = await body(req);
      const authenticated = payload.authenticatedOwnerAddress;
      if (typeof authenticated !== 'string' || authenticated.length > 300)
        throw Error('Authenticated wallet address required');
      if (url.pathname === '/cancel-review' && atomic && batch) {
        const request = object(payload.request, 'review cancellation');
        await batch.cancelReview(sponsorId(request.requestId), authenticated);
        return reply(res, 200, { cancelled: true });
      }
      if (url.pathname === '/offer') {
        if (!atomic && batch)
          return reply(res, 409, {
            error:
              'New predictions use the atomic slip. Refresh checkout; existing signatures remain recoverable.',
          });
        const request = atomic
          ? parseBatchRequest(payload.request)
          : parseSponsorRequest(payload.request);
        if (request.ownerAddress !== authenticated)
          return reply(res, 403, { error: 'Use the wallet linked to the signed-in account.' });
        return reply(res, 200, await service.prepareOffer(request));
      }
      const request = object(payload.request, 'owner submission');
      const offerId = sponsorId(request.offerId),
        rawHash = hash32(request.rawHash, 'transaction hash');
      const entry = service.store.load(offerId);
      if (!entry || entry.ownerAddress !== authenticated || entry.offer.rawHash !== rawHash)
        return reply(res, 403, { error: 'This proposal belongs to another wallet.' });
      if (url.pathname === '/reject') {
        if (!atomic) return reply(res, 404, { error: 'Unknown sponsor operation.' });
        return reply(res, 200, await service.rejectUnsigned({ offerId, rawHash }));
      }
      if (url.pathname === '/resume')
        return reply(res, 200, await service.status({ offerId, rawHash }, true));
      if (url.pathname === '/resolve')
        return reply(
          res,
          200,
          await service.resolveConflict({
            offerId,
            rawHash,
            conflictingTxHash: hash32(request.conflictingTxHash, 'conflicting transaction hash'),
          }),
        );
      if (typeof request.userSignedBytes !== 'string') throw Error('Owner signature required');
      const accepted = await service.submit(
        {
          offerId,
          rawHash,
          userSignedBytes: request.userSignedBytes,
        } satisfies SponsorSubmitRequest,
        atomic,
      );
      reply(res, 200, accepted);
      server.emit('payment-accepted');
      return;
    } catch (error) {
      if (
        error instanceof ReviewWaitingError ||
        (error instanceof OperatorBusyError && operation === 'offer' && req.url === '/batch/offer')
      ) {
        return reply(res, 429, {
          error: 'Your payment review is waiting. No payment has been sent.',
          reviewWait: { position: error instanceof ReviewWaitingError ? error.position : 0 },
        });
      }
      // Do not return provider payloads, RPC errors, file paths or signing context.
      const message = error instanceof Error ? error.message : '';
      const busy = error instanceof OperatorBusyError;
      const safe =
        (operation === 'orders' &&
          [
            'Three payments from this wallet are already processing. You can keep building your next slip.',
            'Finish or cancel an open review before starting another.',
            'This wallet input is no longer available. Review your updated balance.',
            'Wallet funding needs four confirmations before starting this payment.',
            'This match is too close to kickoff to start a new payment.',
            'Wait for an earlier funding transaction before extending this payment chain.',
            'Insufficient unreserved CKB for this payment.',
            'Insufficient unreserved CKB for the picks, refundable queue reserve, network fee and wallet change.',
            'This unsigned review expired. Review the saved picks again.',
            'This review was cancelled before acceptance. Start a new review.',
            'This signed payment is already accepted and will continue automatically.',
          ].includes(message)) ||
        /^(Sponsor is completing|Streak needs additional|Streak is at|Unsigned sponsor offer expired|Invalid owner transaction signature|Fixture terms changed|This fixture already has|Sponsored contract deployment|Sponsor funding is awaiting|Owner needs principal|Owner input must be live|This fixture has reached|This fixture has positions|This fixture has no available|This fixture is closed)/.test(
          message,
        );
      // Fixed categories only. Never log exception text, request bodies, addresses
      // or transaction witnesses from the isolated signing service.
      console.warn(
        JSON.stringify({
          service: 'streak-sponsor',
          operation,
          category: busy ? 'operator-busy' : safe ? 'review-rule' : 'operation-unavailable',
        }),
      );
      reply(res, busy ? 429 : 409, {
        error:
          operation === 'campaign-absence'
            ? 'Campaign operator history is unavailable for absence verification.'
            : operation === 'activity'
              ? 'Activity relay is temporarily unavailable. Its durable observations remain recoverable.'
              : busy
                ? 'Sponsor queue is busy. Your picks and any saved payment are safe. Try again shortly.'
                : safe
                  ? message
                  : operation === 'offer'
                    ? 'Payment review is temporarily unavailable. No payment was sent by this review. Your picks are saved; try again shortly.'
                    : 'Sponsor request could not complete. Your signed payment may still confirm. Check its saved status before retrying.',
      });
    } finally {
      if (['offer', 'submit', 'resume'].includes(operation))
        console.info(
          JSON.stringify({
            service: 'streak-sponsor-timing',
            operation,
            durationMs: Math.round(performance.now() - startedAt),
            status: res.statusCode,
          }),
        );
      active--;
    }
  });
  server.once('close', () => activity.close());
  return server;
}

export async function runSponsorService(): Promise<void> {
  if (process.env.NODE_ENV === 'test')
    throw Error('Live sponsor launcher is forbidden in routine tests');
  const directory = process.env.STREAK_DIRECT_OPERATOR_DIR,
    registryDirectory = process.env.STREAK_DIRECT_REGISTRY_DIR;
  if (
    !directory ||
    !registryDirectory ||
    !isAbsolute(directory) ||
    !isAbsolute(registryDirectory) ||
    resolve(directory) === resolve(registryDirectory)
  )
    throw Error('Configure separate absolute durable operator and registry directories');
  if (process.env.NODE_ENV === 'production' && process.env.STREAK_DIRECT_DURABLE_STATE_ACK !== '1')
    throw Error('Sponsor service needs acknowledged durable operator storage');
  const key = process.env.STREAK_DIRECT_PRIVATE_KEY,
    providerKey = process.env.API_SPORTS_KEY;
  if (!key || !providerKey)
    throw Error(
      'Sponsor launcher needs explicit signing and provider environment; it never loads key files',
    );
  const endpoint = new URL(sponsorServiceUrl(process.env.STREAK_SPONSOR_URL));
  const ipc = secret(process.env.STREAK_SPONSOR_IPC_SECRET);
  if (V3_DIRECT_CONFIG.codeDeps.length !== 2)
    throw Error('Sponsored contract deployment is not ready');
  const client = new ccc.ClientPublicTestnet({
    url: PUBLIC_DIRECT_CONFIG.rpc,
    fallbacks: [],
    timeout: 15_000,
    maxConcurrent: 2,
  });
  const fixtures = createFixtureReader({
    catalogue: () =>
      boundedJson(provisioningCatalogueUrl(process.env.STREAK_DIRECT_CATALOGUE_URL ?? ''), {
        headers: { accept: 'application/json' },
      }),
    fixture: (id) =>
      boundedJson(`${PROVIDER_ORIGIN}/fixtures?id=${id}`, {
        headers: { 'x-apisports-key': providerKey },
      }),
  });
  const service = new SponsorService({
    client,
    signer: new ccc.SignerCkbPrivateKey(client, key),
    journal: new OperatorJournal(directory, undefined, 10_000),
    registry: new DirectRegistry(registryDirectory, V3_DIRECT_CONFIG),
    config: V3_DIRECT_CONFIG,
    fixture: async (id) => (await fixtures([id]))[0],
    fixtures,
  });
  const batchDirectory = process.env.STREAK_DIRECT_BATCH_REGISTRY_DIR;
  if (
    batchDirectory &&
    (!isAbsolute(batchDirectory) ||
      [resolve(directory), resolve(registryDirectory)].includes(resolve(batchDirectory)))
  )
    throw Error('Atomic registry requires a separate absolute directory');
  const batch = batchDirectory
    ? new BatchService({
        ...service.options,
        config: V4_DIRECT_CONFIG,
        registry: new DirectRegistry(batchDirectory, V4_DIRECT_CONFIG),
        existingRegistry: [
          service.options.registry,
          ...(process.env.STREAK_ORDER_REGISTRY_DIR
            ? [new DirectRegistry(process.env.STREAK_ORDER_REGISTRY_DIR, orderConfig())]
            : []),
          ...(process.env.STREAK_DIRECT_LEGACY_REGISTRY_DIR
            ? [new DirectRegistry(process.env.STREAK_DIRECT_LEGACY_REGISTRY_DIR)]
            : []),
        ],
      })
    : undefined;
  const queuedConfig = orderConfig();
  let orders: OrderService | undefined;
  if (queuedConfig.codeDeps.length) {
    const orderDirectory = process.env.STREAK_ORDER_REGISTRY_DIR;
    if (
      !orderDirectory ||
      !isAbsolute(orderDirectory) ||
      [directory, registryDirectory, batchDirectory]
        .filter(Boolean)
        .some((p) => resolve(p!) === resolve(orderDirectory))
    )
      throw Error('Queued markets need a separate absolute registry directory');
    await verifyOrderDeployment(client, queuedConfig);
    const orderRegistry = new DirectRegistry(orderDirectory, queuedConfig);
    const earlierRegistries = [
      service.options.registry,
      ...(batch ? [batch.options.registry] : []),
      ...(batch?.options.existingRegistry ?? []).filter(
        (r) => r.config.protocolHash !== queuedConfig.protocolHash,
      ),
    ];
    orderRegistry.publicationTargets = earlierRegistries;
    for (const registry of earlierRegistries)
      registry.publicationTargets = [
        orderRegistry,
        ...earlierRegistries.filter((r) => r !== registry),
      ];
    const marketPreparation = new OrderMarkets({
      client,
      signer: service.options.signer,
      journal: service.options.journal,
      config: queuedConfig,
      registry: orderRegistry,
      fixtures,
      earlier: earlierRegistries,
    });
    orders = new OrderService({
      client,
      journal: service.options.journal,
      config: queuedConfig,
      registry: orderRegistry,
      marketPreparation,
      validateFixture: async (id) => {
        await fixtures([id]);
      },
    });
  }
  const server = createSponsorServer(service, ipc, batch, {
    orders,
    campaignEmptyHistoryAcknowledged: process.env.STREAK_CAMPAIGNS_EMPTY_HISTORY_ACK === '1',
  });
  server.requestTimeout = 65_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(endpoint.port), '127.0.0.1', () => resolve());
  });
  const recovery = startHostedRecovery(
    server,
    async () => {
      const results = [
        ...(await service.recoverPending()),
        ...(batch ? await batch.recoverPending() : []),
      ];
      await orders?.recoverPending();
      if (results.some((result) => result.needsReview))
        console.error(
          'A sponsored transaction needs bounded-history reconciliation. Its durable bytes remain reserved.',
        );
    },
    () => {
      console.error(
        'Sponsor recovery is unavailable. Keep durable state and reconcile before new funding.',
      );
    },
  );
  const stop = () => {
    void recovery
      .stop()
      .catch(() => {
        console.error('Sponsor shutdown could not complete. Preserve journals for reconciliation.');
        process.exitCode = 1;
      })
      .finally(() => {
        process.off('SIGTERM', stop);
        process.off('SIGINT', stop);
      });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  console.log(
    JSON.stringify({
      service: 'streak-sponsor',
      listen: endpoint.origin,
      network: 'testnet',
      automaticBulkCreation: false,
    }),
  );
}
