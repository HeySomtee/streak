import { ccc } from '@ckb-ccc/core';
import {
  ORDER_PROTOCOL_HASH,
  ORDER_RESERVE,
  ORDER_STORAGE,
  ORDER_MAX_FEE,
  decodeOrder,
  validateOrderOffer,
} from '../../../../shared/order-codec.mjs';
import type {
  OrderConfig,
  OrderOffer,
  OrderStatus,
  OrderCell,
  OrderRequest,
} from '../../../../shared/order-wire';
import { request, isRecord } from '../../lib/http';
import { ORDER_STORE, putStored, storedRecords, otherStoredRecords } from './journal-db';
import { amountShannons, type Pick } from '../predictions/draft';
import { GUARD_HASH, object, configureOrderManifest } from './protocol';
import { parseReservation } from './reservations';

export interface SavedOrder {
  version: 'queued-predictions-v1';
  scope: string;
  hash: string;
  inputs: { txHash: string; index: number }[];
  descriptor: OrderOffer['markets'][number];
  offer: OrderOffer;
  signedBytes: string;
  sourcePicks: Pick[];
  status: 'signed' | 'submitted' | 'discarded';
  discardedAt?: number;
}
export async function getOrderConfig(signal?: AbortSignal): Promise<OrderConfig | null> {
  const deployment = await request('/direct/config', signal);
  if (!isRecord(deployment)) throw Error('Payment configuration could not be verified.');
  if (!deployment.orderDeployment) return null;
  const value = await request('/direct/orders/configuration', signal);
  if (!isRecord(value) || value.enabled !== true)
    throw Error('Queued payments are temporarily unavailable. Your picks are saved.');
  if (
    value.protocolHash !== ORDER_PROTOCOL_HASH ||
    value.guardHash !== GUARD_HASH ||
    value.reserveShannons !== ORDER_RESERVE.toString() ||
    value.maxExecutionFeeShannons !== ORDER_MAX_FEE.toString() ||
    value.maxPendingPerWallet !== 3 ||
    !Array.isArray(value.codeDeps) ||
    value.codeDeps.length !== 2 ||
    !Array.isArray(value.markets) ||
    value.markets.length > 512
  )
    throw Error('Queued-payment configuration could not be verified.');
  for (const raw of value.codeDeps) {
    const dep = object(raw),
      p = object(dep.outPoint);
    if (
      dep.depType !== 'code' ||
      typeof p.txHash !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(p.txHash) ||
      !Number.isInteger(p.index) ||
      Number(p.index) < 0
    )
      throw Error('Invalid queued-payment deployment.');
  }
  for (const ids of [value.plannedFixtureIds, value.reservedFixtureIds, value.legacyFixtureIds])
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > 512 ||
        ids.some((id) => typeof id !== 'string' || !/^api-football-[1-9][0-9]{0,14}$/.test(id)))
    )
      throw Error('Queued-market setup could not be verified.');
  if (value.onDemandMarkets !== undefined && typeof value.onDemandMarkets !== 'boolean')
    throw Error('Invalid market preparation configuration.');
  configureOrderManifest(value);
  return value as unknown as OrderConfig;
}
export function parseOrderStatus(value: unknown): OrderStatus {
  const row = object(value);
  validateOrderOffer(row.offer);
  if (
    ![
      'offered',
      'accepted',
      'funding',
      'waiting',
      'placing',
      'placed',
      'refunding',
      'refunded',
      'attention',
      'failed',
      'cancelled',
    ].includes(String(row.state)) ||
    typeof row.message !== 'string' ||
    row.message.length > 400 ||
    row.fundingHash !== object(row.offer).rawHash ||
    (row.executionHash !== undefined &&
      (typeof row.executionHash !== 'string' || !/^0x[0-9a-f]{64}$/.test(row.executionHash)))
  )
    throw Error('Saved payment status could not be verified.');
  return value as OrderStatus;
}
export async function orderWallet() {
  const value = object(await request('/direct/orders/wallet', undefined, {}));
  if (
    !Array.isArray(value.orders) ||
    value.orders.length > 128 ||
    !Array.isArray(value.parents) ||
    value.parents.length > 128 ||
    !Array.isArray(value.reserved) ||
    value.reserved.length > 100000
  )
    throw Error('Payment history could not be verified.');
  return {
    orders: value.orders.map(parseOrderStatus),
    parents: value.parents.map((c) => ccc.Cell.from(c as OrderCell)),
    reserved: new Set(value.reserved.map(String)),
  };
}
function saved(value: unknown): SavedOrder {
  const row = object(value),
    offer = validateOrderOffer(row.offer);
  if (
    row.version !== 'queued-predictions-v1' ||
    row.hash !== offer.rawHash ||
    typeof row.scope !== 'string' ||
    typeof row.signedBytes !== 'string' ||
    ccc.Transaction.fromBytes(row.signedBytes).hash() !== offer.rawHash ||
    !Array.isArray(row.sourcePicks)
  )
    throw Error('Saved queued payment is inconsistent.');
  return value as SavedOrder;
}
/** Payment capability only; the server still verifies the exact owner lock and signature. */
export function supportsOrderPayments(signer: {
  readonly signType: ccc.Signer['signType'];
}): boolean {
  return ['CkbSecp256k1', 'EvmPersonal'].includes(signer.signType);
}
export class OrderClient {
  constructor(
    readonly signer: ccc.Signer,
    readonly config: OrderConfig,
  ) {}
  async identity() {
    const owner = (await this.signer.getRecommendedAddressObj()).script;
    return { owner, scope: `testnet-v1:${owner.hash()}:wallet` };
  }
  async history() {
    return (await storedRecords(ORDER_STORE, (await this.identity()).scope)).map(saved);
  }
  async prepare(picks: Pick[], accountId: string): Promise<OrderOffer> {
    if (!supportsOrderPayments(this.signer))
      throw Error(
        'This wallet cannot place predictions yet. Your picks are saved. Use MetaMask, Zerion or a supported native CKB wallet. No payment was sent.',
      );
    const { owner, scope } = await this.identity(),
      client = this.signer.client;
    for (const [i, dep] of this.config.codeDeps.entries()) {
      const code = await client.getCellLiveNoCache(dep.outPoint, true, false);
      if (!code || ccc.hashCkb(code.outputData) !== (i === 0 ? ORDER_PROTOCOL_HASH : GUARD_HASH))
        throw Error('Queued-payment code is not available. No payment was sent.');
    }
    const state = await orderWallet(),
      reserved = state.reserved;
    for (const row of [
      ...(await storedRecords(ORDER_STORE, scope)),
      ...(await otherStoredRecords(ORDER_STORE, scope)),
    ]) {
      const reservation = parseReservation(row);
      if (!reservation.discardedUnsubmitted)
        for (const p of reservation.inputs) reserved.add(ccc.OutPoint.from(p).toHex());
    }
    const page = await client.findCellsPagedNoCache(
      { script: owner, scriptType: 'lock', scriptSearchMode: 'exact', withData: true },
      'desc',
      64,
    );
    // Prefer independent wallet cells so separate slips can fund concurrently.
    // Known pending change remains the fallback for a wallet with one large cell.
    const candidates = [...page.cells, ...state.parents].filter(
      (c, i, a) =>
        a.findIndex((p) => p.outPoint.eq(c.outPoint)) === i &&
        !reserved.has(c.outPoint.toHex()) &&
        !c.cellOutput.type &&
        c.outputData === '0x' &&
        c.cellOutput.lock.eq(owner),
    );
    const lines = picks.map((p) => {
      const amount = amountShannons(p.amountCkb);
      if (amount === null || amount < 10_000_000_000n)
        throw Error('Enter at least 100 tCKB for each prediction.');
      return {
        fixtureId: p.matchId,
        outcome: ({ home: 0, draw: 1, away: 2 } as const)[p.outcome],
        principalShannons: amount.toString(),
      };
    });
    const needed =
      lines.reduce((n, p) => n + BigInt(p.principalShannons) + ORDER_STORAGE, ORDER_RESERVE) +
      BigInt(ccc.CellOutput.from({ capacity: 0n, lock: owner }).occupiedSize) * 100_000_000n +
      100_000_000n;
    const selected: ccc.Cell[] = [];
    let total = 0n;
    for (const c of candidates) {
      selected.push(c);
      total += c.cellOutput.capacity;
      if (total >= needed || selected.length === 24) break;
    }
    if (total < needed)
      throw Error(
        'Not enough available CKB for this slip and its refundable storage. Pending payments keep their own funds reserved.',
      );
    for (const cell of selected) {
      const parent = state.orders.find(
        (s) => s.fundingHash === cell.outPoint.txHash && s.state !== 'offered',
      );
      const source = parent
        ? ccc.Transaction.fromBytes(parent.offer.unsignedBytes).getOutput(cell.outPoint.index)
        : await client.getCellLiveNoCache(cell.outPoint, true, true);
      if (
        !source ||
        source.cellOutput.toHex() !== cell.cellOutput.toHex() ||
        source.outputData !== cell.outputData
      )
        throw Error('Wallet funding changed. Review your balance again.');
    }
    for (const p of picks)
      if (p.competition && p.competition.accountId !== accountId)
        throw Error('Review your competition choices for this wallet.');
    const selection = {
      accountId,
      lines: picks.map((p) => ({ fixtureId: p.matchId, campaignIds: p.competition?.ids ?? [] })),
    };
    let markets = this.config.markets;
    if (
      this.config.onDemandMarkets &&
      picks.some((p) => !markets.some((m) => m.fixtureId === p.matchId))
    ) {
      const prepared = object(
        await request(
          '/direct/orders/prepare-markets',
          undefined,
          { fixtureIds: picks.map((p) => p.matchId) },
          60_000,
        ),
      );
      if (!Array.isArray(prepared.markets) || prepared.markets.length !== picks.length)
        throw Error('Market preparation could not be verified. Your picks are saved.');
      // Full immutable descriptor and order binding are validated below, before signing.
      markets = prepared.markets as OrderConfig['markets'];
    }
    const body: OrderRequest = {
      requestId: crypto.randomUUID(),
      ownerAddress: await this.signer.getRecommendedAddress(),
      userInputs: selected.map((c) => ({
        txHash: c.outPoint.txHash,
        index: Number(c.outPoint.index),
      })),
      picks: lines.map((line) => {
        const market = markets.find((m) => m.fixtureId === line.fixtureId);
        if (!market) throw Error('This slip includes a market using the earlier payment flow.');
        return { ...line, termsHash: market.termsHash };
      }),
      competitionSelection: selection,
    };
    const offer = validateOrderOffer(
      await request('/direct/orders/offer', undefined, body, 60_000),
    );
    const data = decodeOrder(offer.orderData);
    const digest = ccc.hexFrom(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(selection))),
      ),
    );
    if (
      !data.owner.eq(owner) ||
      data.selectionDigest !== digest ||
      offer.id !== body.requestId ||
      offer.markets.length !== lines.length ||
      offer.inputs.length !== selected.length
    )
      throw Error('The payment review differs from your slip.');
    offer.inputs.forEach((c, i) => {
      const expected = selected[i];
      if (
        !expected.outPoint.eq(c.outPoint) ||
        expected.cellOutput.toHex() !== ccc.CellOutput.from(c.cellOutput).toHex() ||
        expected.outputData !== c.outputData
      )
        throw Error('The payment changed its wallet inputs.');
    });
    offer.markets.forEach((m, i) => {
      if (
        m.fixtureId !== lines[i].fixtureId ||
        m.termsHash !== body.picks[i].termsHash ||
        data.lines[i].outcome !== lines[i].outcome ||
        data.lines[i].principalShannons !== lines[i].principalShannons
      )
        throw Error('The payment changed a prediction.');
    });
    return offer;
  }
  async sign(
    offer: OrderOffer,
    picks: Pick[],
    assertIdentity: () => Promise<void>,
  ): Promise<SavedOrder> {
    validateOrderOffer(offer);
    await assertIdentity();
    if (Date.now() >= offer.expiresAt) throw Error('This review expired. Review your picks again.');
    const { owner, scope } = await this.identity();
    if (!owner.eq(offer.ownerLock)) throw Error('Your wallet changed.');
    const tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
    offer.inputs.forEach((c, i) => {
      tx.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
      tx.inputs[i].outputData = ccc.hexFrom(c.outputData);
    });
    const signedTx = await this.signer.signTransaction(tx);
    if (signedTx.hash() !== offer.rawHash) throw Error('Your wallet changed the reviewed payment.');
    const record: SavedOrder = {
      version: 'queued-predictions-v1',
      scope,
      hash: offer.rawHash,
      inputs: offer.inputs.map((c) => c.outPoint),
      descriptor: offer.markets[0],
      offer,
      signedBytes: signedTx.toHex(),
      sourcePicks: picks,
      status: 'signed',
    };
    await putStored(ORDER_STORE, record, (previous) => {
      const old = saved(previous);
      if (
        old.signedBytes !== record.signedBytes ||
        JSON.stringify(old.offer) !== JSON.stringify(record.offer)
      )
        throw Error('A different authorization already owns this payment identity.');
    });
    await assertIdentity();
    return record;
  }
  async submit(record: SavedOrder): Promise<OrderStatus> {
    const result = parseOrderStatus(
      await request(
        '/direct/orders/submit',
        undefined,
        { offerId: record.offer.id, rawHash: record.hash, userSignedBytes: record.signedBytes },
        60_000,
      ),
    );
    if (result.fundingHash !== record.hash || result.state === 'offered')
      throw Error('The server has not accepted this payment yet.');
    const acknowledged: SavedOrder = { ...record, status: 'submitted' };
    await putStored(ORDER_STORE, acknowledged);
    return result;
  }
  async cancel(offer: OrderOffer, record?: SavedOrder): Promise<void> {
    if (record && Date.now() < offer.expiresAt)
      throw Error('Wait for this review to expire before retiring its saved signature.');
    const result = parseOrderStatus(
      await request('/direct/orders/cancel-review', undefined, {
        offerId: offer.id,
        rawHash: offer.rawHash,
      }),
    );
    if (
      result.state !== 'cancelled' ||
      result.fundingHash !== offer.rawHash ||
      result.acceptedAt !== undefined
    )
      throw Error('This payment may already be processing. Check its status.');
    if (record) {
      const retired: SavedOrder = { ...record, status: 'discarded', discardedAt: Date.now() };
      await putStored(ORDER_STORE, retired);
    }
  }
}
