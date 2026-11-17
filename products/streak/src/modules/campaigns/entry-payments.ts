import { isDeepStrictEqual } from 'node:util';
import { ccc } from '@ckb-ccc/core';
import type { Pool, PoolClient } from 'pg';
import type { BatchOffer } from '../../../shared/batch-wire';
import type { OrderOffer } from '../../../shared/order-wire';
import { decodeOrder, validateOrderOffer } from '../../../shared/order-codec.mjs';
import type { ActivityPublicEvent } from '../activity/events';
import {
  CampaignError,
  object,
  identifier,
  type Actor,
  type Campaign,
  type CampaignEntry,
  type PredictionSlot,
} from './domain';

interface PaymentIntent {
  offerId: string;
  rawHash: string;
  accountId: string;
  ownerHash: string;
  expiresAt: number;
  state: 'reserved' | 'started' | 'released';
  lines: Array<PredictionSlot & { campaignIds: string[] }>;
}
type EntryOffer = Pick<BatchOffer, 'offerId' | 'rawHash' | 'ownerLock' | 'expiresAt'> & {
  lines: Array<
    Pick<
      BatchOffer['lines'][number],
      'fixture' | 'mode' | 'outputIndex' | 'outcome' | 'principalShannons'
    >
  >;
};
/** Explicit regular-only choices remain valid when competition storage is disabled. */
export function regularOnlySelection(value: unknown, accountId: string): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const selection = value as Record<string, unknown>;
  return (
    selection.accountId === accountId &&
    Array.isArray(selection.lines) &&
    selection.lines.length > 0 &&
    selection.lines.length <= 8 &&
    selection.lines.every((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const line = item as Record<string, unknown>;
      return (
        typeof line.fixtureId === 'string' &&
        Array.isArray(line.campaignIds) &&
        line.campaignIds.length === 0
      );
    })
  );
}
export function orderEntryOffer(value: unknown): EntryOffer {
  const offer: OrderOffer = validateOrderOffer(value),
    data = decodeOrder(offer.orderData);
  return {
    offerId: offer.id,
    rawHash: offer.rawHash,
    ownerLock: offer.ownerLock,
    expiresAt: offer.expiresAt,
    lines: offer.markets.map((market, i) => ({
      fixture: { ...market, sponsorLock: offer.ownerLock, state: 'funded' },
      mode: 'deposit',
      outputIndex: i,
      outcome: data.lines[i].outcome,
      principalShannons: data.lines[i].principalShannons,
    })),
  };
}

/** Private operator output is still checked before it can bind competition points. */
export function entryPaymentOffer(value: unknown): BatchOffer {
  const offer = object(value);
  if (
    offer.version !== 'atomic-predictions-v1' ||
    typeof offer.offerId !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(offer.offerId) ||
    typeof offer.rawHash !== 'string' ||
    !/^0x[0-9a-f]{64}$/.test(offer.rawHash) ||
    typeof offer.unsignedBytes !== 'string' ||
    !Number.isSafeInteger(offer.expiresAt) ||
    !Array.isArray(offer.lines) ||
    !offer.lines.length ||
    offer.lines.length > 8
  )
    throw new CampaignError('Payment review could not be verified.', 503);
  if (ccc.Transaction.fromBytes(offer.unsignedBytes).hash() !== offer.rawHash)
    throw new CampaignError('Payment identity could not be verified.', 503);
  for (const raw of offer.lines) {
    const line = object(raw),
      fixture = object(line.fixture);
    identifier(fixture.fixtureId);
    if (
      ![0, 1, 2].includes(Number(line.outcome)) ||
      !Number.isSafeInteger(line.outcome) ||
      typeof line.principalShannons !== 'string' ||
      !/^[1-9][0-9]{0,20}$/.test(line.principalShannons) ||
      !Number.isSafeInteger(line.outputIndex) ||
      Number(line.outputIndex) < 0 ||
      !['create', 'deposit'].includes(String(line.mode))
    )
      throw new CampaignError('Payment line could not be verified.', 503);
  }
  // Remaining payment fields are validated independently by the wallet's protocol verifier.
  return value as BatchOffer;
}

/** A durable intent is scoring metadata, never authority to sign or spend CKB. */
export class CampaignEntryPayments {
  private ready?: Promise<void>;
  constructor(
    private readonly pool: Pool,
    private readonly initialize: () => Promise<void>,
    private readonly wake: () => void,
  ) {}
  private init(): Promise<void> {
    this.ready ??= this.initialize()
      .then(async () => {
        await this.pool.query(`CREATE TABLE IF NOT EXISTS streak_campaign_payment_intents (
        offer_id text PRIMARY KEY, raw_hash text NOT NULL, owner_hash text NOT NULL,
        data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
        ALTER TABLE streak_campaign_payment_intents DROP CONSTRAINT IF EXISTS streak_campaign_payment_intents_raw_hash_key;
        CREATE UNIQUE INDEX IF NOT EXISTS streak_campaign_payment_active_hash ON streak_campaign_payment_intents(raw_hash)
          WHERE data->>'state'<>'released';
        CREATE INDEX IF NOT EXISTS streak_campaign_payment_hash_history ON streak_campaign_payment_intents(raw_hash)`);
      })
      .catch((error: unknown) => {
        this.ready = undefined;
        throw error;
      });
    return this.ready;
  }
  private async transaction<T>(
    ownerHash: string,
    work: (client: PoolClient, now: number) => Promise<T>,
  ): Promise<T> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 5000');
      // Serialize this wallet's intent lifecycle, not other wallets' payments.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 73))', [ownerHash]);
      const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
      const result = await work(client, time.rows[0].now.getTime());
      await client.query('COMMIT');
      this.wake();
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async reserve(actor: Actor, offer: EntryOffer, selection: unknown): Promise<void> {
    if (ccc.Script.from(offer.ownerLock).hash() !== actor.ownerHash)
      throw new CampaignError('Use the signed-in wallet for this payment.', 403);
    const choices = new Map<string, string[]>();
    if (selection !== undefined) {
      const selected = object(selection);
      if (
        selected.accountId !== actor.id ||
        !Array.isArray(selected.lines) ||
        selected.lines.length !== offer.lines.length
      )
        throw new CampaignError(
          'Your account or competition selection changed. Review the slip again.',
          409,
        );
      for (const raw of selected.lines) {
        const line = object(raw),
          fixtureId = identifier(line.fixtureId);
        if (
          !Array.isArray(line.campaignIds) ||
          line.campaignIds.length > 20 ||
          choices.has(fixtureId)
        )
          throw new CampaignError('Invalid competition selection.');
        const ids = line.campaignIds.map(identifier).sort();
        if (
          new Set(ids).size !== ids.length ||
          !offer.lines.some((item) => item.fixture.fixtureId === fixtureId)
        )
          throw new CampaignError('Invalid competition selection.');
        choices.set(fixtureId, ids);
      }
    }
    const intent: PaymentIntent = {
      offerId: offer.offerId,
      rawHash: offer.rawHash,
      accountId: actor.id,
      ownerHash: actor.ownerHash,
      expiresAt: offer.expiresAt,
      state: 'reserved',
      lines: offer.lines.map((line) => ({
        fixtureId: line.fixture.fixtureId,
        offerId: offer.offerId,
        rawHash: offer.rawHash,
        outputIndex: line.outputIndex + (line.mode === 'create' ? 1 : 0),
        outcome: line.outcome,
        principalShannons: line.principalShannons,
        expiresAt: offer.expiresAt,
        state: 'reserved',
        campaignIds: choices.get(line.fixture.fixtureId) ?? [],
      })),
    };
    await this.transaction(actor.ownerHash, async (client, now) => {
      const prior = await client.query<{ data: PaymentIntent }>(
        'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1 OR raw_hash=$2',
        [intent.offerId, intent.rawHash],
      );
      const previous = prior.rows.find((row) => row.data.offerId === intent.offerId)?.data;
      if (previous) {
        if (!isDeepStrictEqual({ ...previous, state: 'reserved' }, intent))
          throw new CampaignError(
            'This payment already has a saved competition choice. Start a fresh review to change it.',
            409,
          );
        if (previous.state !== 'reserved' || now >= previous.expiresAt)
          throw new CampaignError(
            'This payment is already submitted or expired. Check its saved status.',
            409,
          );
        return;
      }
      for (const { data: earlier } of prior.rows) {
        if (
          earlier.ownerHash !== actor.ownerHash ||
          earlier.accountId !== actor.id ||
          earlier.state === 'started' ||
          (earlier.state === 'reserved' && earlier.expiresAt > now)
        )
          throw new CampaignError(
            'This transaction already has an active competition choice. Check its saved payment.',
            409,
          );
        // A fresh unsigned offer may reconstruct identical CKB bytes after an
        // earlier review was safely released. Old offer IDs remain blocked forever.
        if (earlier.state === 'reserved') {
          earlier.state = 'released';
          await client.query(
            'UPDATE streak_campaign_payment_intents SET data=$2 WHERE offer_id=$1',
            [earlier.offerId, JSON.stringify(earlier)],
          );
        }
      }
      if (now >= intent.expiresAt)
        throw new CampaignError('The payment review expired. Please review again.', 409);
      await this.updateEntries(client, intent, actor.id, now, false);
      await client.query(
        'INSERT INTO streak_campaign_payment_intents(offer_id,raw_hash,owner_hash,data) VALUES($1,$2,$3,$4)',
        [intent.offerId, intent.rawHash, intent.ownerHash, JSON.stringify(intent)],
      );
    });
  }
  async start(actor: Actor, identity: unknown): Promise<void> {
    const request = object(identity);
    await this.transaction(actor.ownerHash, async (client, now) => {
      const result = await client.query<{ data: PaymentIntent }>(
        'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1',
        [request.offerId],
      );
      const intent = result.rows[0]?.data;
      // Historical saved payments predate explicit choices and keep ordinary recovery.
      if (!intent) return;
      if (
        intent.ownerHash !== actor.ownerHash ||
        intent.accountId !== actor.id ||
        intent.rawHash !== request.rawHash
      )
        throw new CampaignError('This saved payment belongs to another wallet.', 403);
      if (intent.state === 'started') return;
      if (intent.state === 'released')
        throw new CampaignError('This review was cancelled. Prepare a new payment.', 409);
      if (now >= intent.expiresAt)
        throw new CampaignError(
          'This unsigned review expired. Review your competition choices again.',
          409,
        );
      intent.state = 'started';
      await this.updateEntries(client, intent, actor.id, now, true);
      await client.query('UPDATE streak_campaign_payment_intents SET data=$2 WHERE offer_id=$1', [
        intent.offerId,
        JSON.stringify(intent),
      ]);
    });
  }
  async observe(value: unknown): Promise<void> {
    const status = object(value);
    // Only the private operator response reaches this observer. An explicit unsigned
    // cancellation also proves that no owner signature was ever accepted. A signed
    // conflict alone must not release a competition slot because its proof can reorg.
    if (
      (status.state !== 'expired' &&
        !(status.state === 'cancelled' && status.unsignedCancellation === true)) ||
      status.signedBytes
    )
      return;
    const offer = entryPaymentOffer(status.offer);
    await this.init();
    const result = await this.pool.query<{ data: PaymentIntent }>(
      'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1 AND raw_hash=$2',
      [offer.offerId, offer.rawHash],
    );
    const intent = result.rows[0]?.data;
    if (!intent) return;
    await this.releaseIntent(
      { id: intent.accountId, ownerHash: intent.ownerHash, name: '', wallet: '' },
      offer,
      true,
    );
  }
  /** Called only for a freshly verified canonical order execution, never its funding receipt. */
  async bindOrderExecution(event: ActivityPublicEvent): Promise<void> {
    if (!event.order || !event.ownerHash) return;
    const outcome =
      event.state === 'refunded' || event.state === 'failed' ? event.state : undefined;
    const confirming = event.state === 'confirming' && event.order.revision !== undefined;
    if (event.kind !== 'payment' || (!outcome && !confirming && event.state !== 'funded'))
      throw new CampaignError('Queued execution is not confirmed.', 503);
    if (!outcome && !confirming && !event.positions)
      throw new CampaignError('Queued execution has no predictions.', 503);
    await this.init();
    await this.transaction(event.ownerHash, async (client, now) => {
      const rows = await client.query<{ data: PaymentIntent }>(
        'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1 AND raw_hash=$2',
        [event.order!.offerId, event.order!.fundingHash],
      );
      const intent = rows.rows[0]?.data;
      if (!intent) return;
      if (
        intent.ownerHash !== event.ownerHash ||
        intent.state !== 'started' ||
        (!outcome && !confirming && intent.lines.length !== event.positions!.length)
      )
        throw new CampaignError('Queued competition authorization differs.', 503);
      for (const [i, line] of (outcome || confirming ? [] : intent.lines).entries()) {
        const p = event.positions![i];
        if (
          p.descriptor.fixtureId !== line.fixtureId ||
          p.ownerHash !== intent.ownerHash ||
          p.position.outcome !== line.outcome ||
          p.position.principalShannons !== line.principalShannons ||
          p.position.outPoint?.index !== i ||
          p.position.outPoint?.txHash !== event.transactionHash ||
          p.position.transactionHash !== event.transactionHash
        )
          throw new CampaignError('Queued competition prediction differs.', 503);
      }
      for (const id of [...new Set(intent.lines.flatMap((l) => l.campaignIds))].sort()) {
        const campaigns = await client.query<{ data: Campaign }>(
          'SELECT data FROM streak_campaigns WHERE id=$1 FOR UPDATE',
          [id],
        );
        const campaign = campaigns.rows[0]?.data;
        if (!campaign) continue;
        const entries = await client.query<{ data: CampaignEntry }>(
          'SELECT data FROM streak_campaign_entries WHERE campaign_id=$1 AND account_id=$2 FOR UPDATE',
          [id, intent.accountId],
        );
        const entry = entries.rows[0]?.data;
        if (!entry) continue;
        let changed = false;
        for (const slot of entry.predictionSlots ?? [])
          if (slot.offerId === intent.offerId) {
            if ((slot.orderRevision ?? 0) > (event.order!.revision ?? 0)) continue;
            const index = intent.lines.findIndex((l) => l.fixtureId === slot.fixtureId);
            if (index < 0) throw new CampaignError('Queued competition slot differs.', 503);
            if (slot.orderOutcome !== outcome || slot.orderRevision !== event.order!.revision) {
              slot.orderOutcome = outcome;
              slot.orderRevision = event.order!.revision;
              changed = true;
            }
            if (
              !outcome &&
              !confirming &&
              (slot.rawHash !== event.transactionHash || slot.outputIndex !== index)
            ) {
              slot.rawHash = event.transactionHash;
              slot.outputIndex = index;
              changed = true;
            }
          }
        if (!changed) continue;
        campaign.revision++;
        campaign.updatedAt = new Date(now).toISOString();
        await client.query(
          'UPDATE streak_campaign_entries SET data=$3 WHERE campaign_id=$1 AND account_id=$2',
          [id, intent.accountId, JSON.stringify(entry)],
        );
        await client.query(
          'UPDATE streak_campaigns SET data=$2,due_at=clock_timestamp(),wake_generation=wake_generation+1 WHERE id=$1',
          [id, JSON.stringify(campaign)],
        );
        await client.query(
          "INSERT INTO streak_campaign_audit(campaign_id,revision,actor_id,action,data) SELECT id,(data->>'revision')::integer,$2,$3,$4 FROM streak_campaigns WHERE id=$1",
          [
            id,
            intent.accountId,
            'queued-entry-executed',
            JSON.stringify({
              offerId: intent.offerId,
              fundingHash: intent.rawHash,
              executionHash: event.transactionHash,
            }),
          ],
        );
      }
    });
  }
  async release(actor: Actor, identity: unknown): Promise<boolean> {
    return this.releaseIntent(actor, identity, false);
  }
  async observeOrderCancellation(value: unknown): Promise<void> {
    const status = object(value);
    if (status.state !== 'cancelled' || status.acceptedAt !== undefined)
      throw new CampaignError('Order cancellation was not confirmed.', 503);
    const offer = validateOrderOffer(status.offer);
    await this.init();
    const result = await this.pool.query<{ data: PaymentIntent }>(
      'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1 AND raw_hash=$2',
      [offer.id, offer.rawHash],
    );
    const intent = result.rows[0]?.data;
    if (!intent) return;
    await this.releaseIntent(
      { id: intent.accountId, ownerHash: intent.ownerHash, name: '', wallet: '' },
      { offerId: offer.id, rawHash: offer.rawHash },
      true,
    );
  }
  private async releaseIntent(
    actor: Actor,
    identity: unknown,
    expiredUnsigned: boolean,
  ): Promise<boolean> {
    const request = object(identity);
    return this.transaction(actor.ownerHash, async (client, now) => {
      const result = await client.query<{ data: PaymentIntent }>(
        'SELECT data FROM streak_campaign_payment_intents WHERE offer_id=$1',
        [request.offerId],
      );
      const intent = result.rows[0]?.data;
      if (!intent) return true;
      if (
        intent.ownerHash !== actor.ownerHash ||
        intent.accountId !== actor.id ||
        intent.rawHash !== request.rawHash
      )
        throw new CampaignError('This saved payment belongs to another wallet.', 403);
      if (intent.state === 'started' && !expiredUnsigned) return false;
      if (intent.state === 'released') return true;
      for (const id of [...new Set(intent.lines.flatMap((line) => line.campaignIds))].sort()) {
        const rows = await client.query<{ data: Campaign }>(
          'SELECT data FROM streak_campaigns WHERE id=$1 FOR UPDATE',
          [id],
        );
        const campaign = rows.rows[0]?.data;
        const entries = await client.query<{ data: CampaignEntry }>(
          'SELECT data FROM streak_campaign_entries WHERE campaign_id=$1 AND account_id=$2',
          [id, actor.id],
        );
        const entry = entries.rows[0]?.data;
        if (!campaign || !entry)
          throw new CampaignError('Saved entry could not be checked. Please retry.', 503);
        entry.predictionSlots = (entry.predictionSlots ?? []).filter(
          (slot) => slot.offerId !== intent.offerId,
        );
        campaign.revision++;
        campaign.updatedAt = new Date(now).toISOString();
        await client.query(
          'UPDATE streak_campaign_entries SET data=$3 WHERE campaign_id=$1 AND account_id=$2',
          [id, actor.id, JSON.stringify(entry)],
        );
        await client.query(
          'UPDATE streak_campaigns SET data=$2,due_at=clock_timestamp(),wake_generation=wake_generation+1 WHERE id=$1',
          [id, JSON.stringify(campaign)],
        );
        await client.query(
          'INSERT INTO streak_campaign_audit(campaign_id,revision,actor_id,action,data) VALUES($1,$2,$3,$4,$5)',
          [
            id,
            campaign.revision,
            actor.id,
            'entry-review-released',
            JSON.stringify({ offerId: intent.offerId, entry }),
          ],
        );
      }
      intent.state = 'released';
      await client.query('UPDATE streak_campaign_payment_intents SET data=$2 WHERE offer_id=$1', [
        intent.offerId,
        JSON.stringify(intent),
      ]);
      return true;
    });
  }
  private async updateEntries(
    client: PoolClient,
    intent: PaymentIntent,
    actorId: string,
    now: number,
    starting: boolean,
  ): Promise<void> {
    const ids = [...new Set(intent.lines.flatMap((line) => line.campaignIds))].sort();
    // All cutoffs use a clock read after lock waits, never request-arrival time.
    for (const id of ids)
      await client.query('SELECT id FROM streak_campaigns WHERE id=$1 FOR UPDATE', [id]);
    const time = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    now = time.rows[0].now.getTime();
    if (now >= intent.expiresAt)
      throw new CampaignError('This unsigned review expired. Review your choices again.', 409);
    for (const id of ids) {
      const rows = await client.query<{ data: Campaign }>(
        'SELECT data FROM streak_campaigns WHERE id=$1 FOR UPDATE',
        [id],
      );
      const campaign = rows.rows[0]?.data;
      const entries = await client.query<{ data: CampaignEntry }>(
        'SELECT data FROM streak_campaign_entries WHERE campaign_id=$1 AND account_id=$2',
        [id, actorId],
      );
      const entry = entries.rows[0]?.data;
      if (
        !campaign ||
        !entry ||
        entry.ownerHash !== intent.ownerHash ||
        campaign.predictionEntryPolicy !== 'explicit-entry-v3' ||
        campaign.draft.kind !== 'predictions' ||
        campaign.state !== 'published' ||
        campaign.deletedAt ||
        campaign.evidenceFinal
      )
        throw new CampaignError(
          'A selected competition is no longer available. Review your choices before paying.',
          409,
        );
      for (const line of intent.lines.filter((item) => item.campaignIds.includes(id))) {
        const fixture = campaign.fixtures.find((item) => item.fixtureId === line.fixtureId);
        if (!fixture || now >= Date.parse(fixture.cutoffAt))
          throw new CampaignError(
            'A selected competition fixture has closed. Review the slip again.',
            409,
          );
        const previous = entry.predictionSlots?.find((slot) => slot.fixtureId === line.fixtureId);
        if (
          starting
            ? previous?.offerId !== intent.offerId
            : entry.calls.some((call) => call.fixtureId === line.fixtureId) ||
              (previous && (previous.state === 'started' || previous.expiresAt > now))
        )
          throw new CampaignError(
            'You already entered this fixture or have a payment pending. Choose a regular prediction or check your saved payment.',
            409,
          );
        const { campaignIds: _ids, ...slot } = line;
        entry.predictionSlots = [
          ...(entry.predictionSlots ?? []).filter((item) => item.fixtureId !== line.fixtureId),
          { ...slot, state: starting ? 'started' : 'reserved' },
        ];
      }
      campaign.revision++;
      campaign.updatedAt = new Date(now).toISOString();
      await client.query(
        'UPDATE streak_campaign_entries SET data=$3 WHERE campaign_id=$1 AND account_id=$2',
        [id, actorId, JSON.stringify(entry)],
      );
      await client.query(
        'UPDATE streak_campaigns SET data=$2,due_at=clock_timestamp(),wake_generation=wake_generation+1 WHERE id=$1',
        [id, JSON.stringify(campaign)],
      );
      await client.query(
        'INSERT INTO streak_campaign_audit(campaign_id,revision,actor_id,action,data) VALUES($1,$2,$3,$4,$5)',
        [
          id,
          campaign.revision,
          actorId,
          starting ? 'entry-payment-started' : 'entry-payment-reserved',
          JSON.stringify({ offerId: intent.offerId, rawHash: intent.rawHash, entry }),
        ],
      );
    }
  }
}
