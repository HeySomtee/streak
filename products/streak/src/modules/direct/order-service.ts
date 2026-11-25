import { genesisReservedInputs } from './genesis-plans';
import * as ccc from '@ckb-ccc/core';
import { createHash } from 'node:crypto';
import {
  decodeOrder,
  encodeOrder,
  orderFee,
  orderLock,
  ORDER_MAX_FEE,
  ORDER_RESERVE,
  ORDER_STORAGE,
} from '../../../shared/order-codec.mjs';
import type {
  OrderCell,
  OrderConfig,
  OrderOffer,
  OrderPoint,
  OrderRecord,
  OrderRequest,
  OrderStatus,
} from '../../../shared/order-wire';
import { DirectRegistry, type DirectProtocolConfig, validateRecord } from './registry';
import { OperatorJournal } from './journal';
import { loadOperatorMarket } from './operator';
import { sponsoredWalletMode } from './sponsor';
import { parseBatchRequest } from './batch';
import { OrderStore } from './order-store';
import { verifyOrderSignature } from './order-signature';
import { atomicReservations } from './atomic-reservations';
import { isDeepStrictEqual } from 'node:util';
import { admissionDrain } from './admission-drain';
import { orderReservedInputs } from './order-reservations';
import { readBatch } from './read-batch';
import { queuedFixtureIds } from './queued-fixtures';
import { readMarketRollovers } from './market-rollover';
import type { OrderMarkets } from './order-markets';

const pointKey = (p: ccc.OutPointLike) => ccc.OutPoint.from(p).toHex();
const point = (p: ccc.OutPoint): OrderPoint => ({ txHash: p.txHash, index: Number(p.index) });
const terminal = (r: OrderRecord) =>
  r.state === 'placed' || r.state === 'refunded' || r.state === 'failed';
const copyCell = (c: ccc.Cell): OrderCell => ({
  outPoint: point(c.outPoint),
  cellOutput: {
    capacity: c.cellOutput.capacity.toString(),
    lock: {
      codeHash: c.cellOutput.lock.codeHash,
      hashType: c.cellOutput.lock.hashType,
      args: c.cellOutput.lock.args,
    },
    ...(c.cellOutput.type
      ? {
          type: {
            codeHash: c.cellOutput.type.codeHash,
            hashType: c.cellOutput.type.hashType,
            args: c.cellOutput.type.args,
          },
        }
      : {}),
  },
  outputData: c.outputData,
});

export interface OrderOptions {
  client: ccc.Client;
  journal: OperatorJournal;
  registry: DirectRegistry;
  config: DirectProtocolConfig;
  now?: () => number;
  marketPreparation?: OrderMarkets;
  /** Fresh provider validation, including the selected immutable catalogue terms. */
  validateFixture: (fixtureId: string) => Promise<void>;
  /** Canonical execution projection; delivery is retried until acknowledged. */
  onObservation?: (row: OrderRecord) => Promise<void>;
}

class RecoveryChanged extends Error {}

export class OrderService {
  readonly store: OrderStore;
  readonly now: () => number;
  private cursor = 0;
  constructor(readonly options: OrderOptions) {
    this.store = new OrderStore(options.journal.directory, options.config.protocolHash);
    this.now = options.now ?? Date.now;
  }
  configuration(): OrderConfig {
    return {
      ...this.options.config,
      enabled: this.options.config.codeDeps.length === 2,
      onDemandMarkets: !!this.options.marketPreparation,
      legacyFixtureIds: this.options.marketPreparation?.legacyFixtureIds() ?? [],
      reserveShannons: ORDER_RESERVE.toString(),
      maxExecutionFeeShannons: ORDER_MAX_FEE.toString(),
      maxPendingPerWallet: 3,
      reservedFixtureIds: [
        ...new Set([
          ...queuedFixtureIds(this.options.journal.directory),
          ...readMarketRollovers(this.options.registry.directory),
        ]),
      ],
      markets: this.options.registry
        .all()
        .filter((m) => m.cutoffMs > this.now() + 120_000)
        .slice(0, 512),
    };
  }
  private public(row: OrderRecord): OrderStatus {
    if (row.state === 'cancelled')
      return {
        offer: row.offer,
        state: 'cancelled',
        fundingHash: row.offer.rawHash,
        message: 'This review was cancelled before server acceptance. Your picks are saved.',
      };
    const messages: Record<Exclude<OrderRecord['state'], 'cancelled'>, string> = {
      offered: 'Review this payment before approving your wallet.',
      accepted: 'Saved for processing. You can leave the app or start another slip.',
      funding: 'Your funding transaction is confirming. Streak will continue automatically.',
      waiting: 'Funded and waiting for market capacity. You can leave the app.',
      placing: 'Your predictions are being placed. No further approval is needed.',
      placed:
        'Your predictions are on-chain. Deadline checks determine whether they enter or are refunded.',
      refunding: 'This slip could not enter in time. Its refund is being processed.',
      refunded: 'This slip was refunded to your wallet.',
      attention: 'Processing needs attention. Your original authorization is saved.',
      failed:
        'This payment did not fund because its wallet input was spent by another confirmed transaction.',
    };
    return {
      offer: row.offer,
      state: row.state,
      acceptedAt: row.acceptedAt,
      fundingHash: row.offer.rawHash,
      ...(row.executionBytes
        ? { executionHash: ccc.Transaction.fromBytes(row.executionBytes).hash() }
        : {}),
      message: messages[row.state],
    };
  }
  async wallet(ownerAddress: string) {
    const owner = (await ccc.Address.fromString(ownerAddress, this.options.client)).script;
    const reserved = genesisReservedInputs(this.options.journal.directory, this.now());
    const orders: OrderStatus[] = [];
    const candidates: OrderCell[] = [];
    // Do not hydrate every historical execution and signature for a history read.
    // Retain only bounded public history and possible pending change outputs.
    for (const row of this.store.scan()) {
      if (!ccc.Script.from(row.offer.ownerLock).eq(owner)) continue;
      if (row.state !== 'cancelled' && (row.signedBytes || row.offer.expiresAt > this.now()))
        for (const input of row.offer.inputs) reserved.add(pointKey(input.outPoint));
      if (!row.signedBytes) continue;
      orders.push(this.public(row));
      orders.sort((a, b) => (b.acceptedAt ?? 0) - (a.acceptedAt ?? 0));
      if (orders.length > 128) orders.pop();
      if (terminal(row)) continue;
      const tx = ccc.Transaction.fromBytes(row.signedBytes);
      const op = ccc.OutPoint.from({ txHash: tx.hash(), index: 1 });
      if (tx.outputs[1]?.lock.eq(owner))
        candidates.push(
          copyCell(ccc.Cell.from({ outPoint: op, cellOutput: tx.outputs[1], outputData: '0x' })),
        );
    }
    const legacy = atomicReservations(this.options.journal, this.now(), new Set());
    for (const input of legacy.pending(legacy.allowed).inputs) reserved.add(input);
    return {
      orders,
      reserved: [...reserved],
      parents: candidates.filter((cell) => !reserved.has(pointKey(cell.outPoint))),
    };
  }
  private async input(
    p: OrderPoint,
    owner: ccc.Script,
    rows: OrderRecord[],
  ): Promise<{ cell: ccc.Cell; parent?: string }> {
    const parent = rows.find(
      (r) =>
        r.offer.rawHash === p.txHash &&
        r.signedBytes &&
        ccc.Script.from(r.offer.ownerLock).eq(owner),
    );
    if (parent && p.index === 1) {
      if (parent.state === 'failed')
        throw Error('The earlier wallet funding transaction needs recovery.');
      if (
        (await this.confirmed(p.txHash)) &&
        !(await this.options.client.getCellLiveNoCache(p, true, true))
      )
        throw Error('This wallet change has already been spent.');
      const tx = ccc.Transaction.fromBytes(parent.signedBytes!);
      if (!tx.outputs[1]?.lock.eq(owner)) throw Error('Invalid parent wallet change');
      return {
        cell: ccc.Cell.from({ outPoint: p, cellOutput: tx.outputs[1], outputData: '0x' }),
        parent: p.txHash,
      };
    }
    const cell = await this.options.client.getCellLiveNoCache(p, true, true);
    if (
      !cell ||
      cell.cellOutput.type ||
      cell.outputData !== '0x' ||
      !cell.cellOutput.lock.eq(owner)
    )
      throw Error('This wallet input is no longer available. Review your updated balance.');
    if (!(await this.confirmed(p.txHash)))
      throw Error('Wallet funding needs four confirmations before starting this payment.');
    return { cell };
  }
  async prepare(value: unknown): Promise<OrderOffer> {
    const request: OrderRequest = parseBatchRequest(value);
    if (
      value &&
      typeof value === 'object' &&
      'competitionSelection' in value &&
      value.competitionSelection !== undefined
    ) {
      const selected = value.competitionSelection as NonNullable<
        OrderRequest['competitionSelection']
      >;
      if (
        !selected ||
        typeof selected.accountId !== 'string' ||
        selected.accountId.length > 120 ||
        !Array.isArray(selected.lines) ||
        selected.lines.length !== request.picks.length ||
        selected.lines.some(
          (line, i) =>
            line.fixtureId !== request.picks[i].fixtureId ||
            !Array.isArray(line.campaignIds) ||
            line.campaignIds.length > 20 ||
            line.campaignIds.some((id) => typeof id !== 'string' || id.length > 120),
        )
      )
        throw Error('Invalid competition choice');
      request.competitionSelection = selected;
    }
    return this.options.journal.exclusive(async () => {
      if (this.options.config.codeDeps.length !== 2)
        throw Error('Queued payments are awaiting verified deployment.');
      const prior = this.store.load(request.requestId);
      if (prior) {
        if (prior.state === 'cancelled')
          throw Error('This review was cancelled. Start a new review.');
        const old = decodeOrder(prior.offer.orderData);
        if (
          prior.offer.ownerAddress !== request.ownerAddress ||
          prior.offer.markets.some(
            (m, i) =>
              m.fixtureId !== request.picks[i]?.fixtureId ||
              m.termsHash !== request.picks[i]?.termsHash ||
              old.lines[i].principalShannons !== request.picks[i]?.principalShannons ||
              old.lines[i].outcome !== request.picks[i]?.outcome,
          ) ||
          prior.offer.markets.length !== request.picks.length ||
          !isDeepStrictEqual(prior.offer.competitionSelection, request.competitionSelection) ||
          !isDeepStrictEqual(
            prior.offer.inputs.map((c) => c.outPoint),
            request.userInputs,
          )
        )
          throw Error('Request identity already belongs to another slip');
        return prior.offer;
      }
      const rows = this.store.all(
          (r) => !terminal(r) && (!!r.signedBytes || r.offer.expiresAt > this.now()),
        ),
        owner = (await ccc.Address.fromString(request.ownerAddress, this.options.client)).script;
      // This bounds scheduling, not spend authority. All signed inputs remain
      // reserved even for terminal records; background canonical checks restore
      // reorged jobs without trusting a stored status to release any funds.
      const active = rows.filter((r) => r.signedBytes && !terminal(r));
      if (
        active.length >= 128 ||
        active.filter((r) => ccc.Script.from(r.offer.ownerLock).eq(owner)).length >= 3
      )
        throw Error(
          'Three payments from this wallet are already processing. You can keep building your next slip.',
        );
      const unsigned = rows.filter((r) => r.state === 'offered' && r.offer.expiresAt > this.now());
      if (
        active.length + unsigned.length >= 128 ||
        [...active, ...unsigned].filter((r) => ccc.Script.from(r.offer.ownerLock).eq(owner))
          .length >= 3
      )
        throw Error('Finish or cancel an open review before starting another.');
      const reserved = new Set<string>(
        rows
          .filter(
            (r) => r.state !== 'cancelled' && (r.signedBytes || r.offer.expiresAt > this.now()),
          )
          .flatMap((r) => r.offer.inputs.map((c) => pointKey(c.outPoint))),
      );
      const legacy = atomicReservations(this.options.journal, this.now(), new Set());
      for (const input of legacy.pending(legacy.allowed).inputs) reserved.add(input);
      for (const input of genesisReservedInputs(this.options.journal.directory, this.now()))
        reserved.add(input);
      if (request.userInputs.some((p) => reserved.has(pointKey(p))))
        throw Error(
          'These funds already belong to another payment. Use the available wallet change.',
        );
      const markets = [];
      await readBatch(request.picks, (pick) => this.options.validateFixture(pick.fixtureId));
      for (const pick of request.picks) {
        const market =
          this.options.marketPreparation?.get(pick.fixtureId) ??
          this.options.registry.get(pick.fixtureId);
        if (
          !market ||
          market.termsHash !== pick.termsHash ||
          market.type.codeHash !== this.options.config.protocolHash
        )
          throw Error(
            'This fixture has not opened for queued payments. Existing markets keep their original payment flow.',
          );
        validateRecord(market, this.options.config);
        if (this.now() + 120_000 >= market.cutoffMs)
          throw Error('This match is too close to kickoff to start a new payment.');
        markets.push(market);
      }
      const selectionDigest = `0x${createHash('sha256')
        .update(JSON.stringify(request.competitionSelection ?? null))
        .digest('hex')}`;
      const data = encodeOrder(
        owner,
        markets.map((m, i) => ({
          marketHash: ccc.Script.from(m.type).hash(),
          cutoffMs: m.cutoffMs,
          outcome: request.picks[i].outcome,
          principalShannons: request.picks[i].principalShannons,
        })),
        selectionDigest,
      );
      const inputs = await Promise.all(request.userInputs.map((p) => this.input(p, owner, rows)));
      const parents = [...new Set(inputs.flatMap((i) => (i.parent ? [i.parent] : [])))];
      const depth = async (hash: string, seen = new Set<string>()): Promise<number> => {
        if (seen.has(hash)) throw Error('Cyclic payment dependency');
        if (await this.confirmed(hash)) return 0;
        seen.add(hash);
        const row = rows.find((r) => r.offer.rawHash === hash);
        return (
          1 +
          Math.max(
            0,
            ...(await Promise.all((row?.offer.parents ?? []).map((p) => depth(p, new Set(seen))))),
          )
        );
      };
      if ((await Promise.all(parents.map((p) => depth(p)))).some((n) => n >= 3))
        throw Error('Wait for an earlier funding transaction before extending this payment chain.');
      const capacity = inputs.reduce((n, i) => n + i.cell.cellOutput.capacity, 0n),
        change = capacity - data.capacity;
      if (change < 100_000_000n) throw Error('Insufficient unreserved CKB for this payment.');
      const tx = ccc.Transaction.from({
        inputs: inputs.map((i) => ({
          previousOutput: i.cell.outPoint,
          cellOutput: i.cell.cellOutput,
          outputData: i.cell.outputData,
          since: 0n,
        })),
        outputs: [
          { capacity: data.capacity, lock: orderLock(this.options.config.protocolHash, data.data) },
          { capacity: change, lock: owner },
        ],
        outputsData: [data.data, '0x'],
      });
      const mode = await sponsoredWalletMode(this.options.client, owner);
      await tx.addCellDepsOfKnownScripts(
        this.options.client,
        mode === 'native' ? ccc.KnownScript.Secp256k1Blake160 : ccc.KnownScript.OmniLock,
      );
      await tx.prepareSighashAllWitness(owner, mode === 'native' ? 65 : 85, this.options.client);
      while (tx.witnesses.length < tx.inputs.length) tx.witnesses.push('0x');
      const fee = orderFee(tx);
      tx.outputs[1].capacity -= fee;
      if (
        tx.outputs.some(
          (o, i) =>
            o.capacity <
            BigInt(o.occupiedSize + ccc.bytesFrom(tx.outputsData[i]).length) * 100_000_000n,
        )
      )
        throw Error(
          'Insufficient unreserved CKB for the picks, refundable queue reserve, network fee and wallet change.',
        );
      const createdAt = this.now();
      const offer: OrderOffer = {
        version: 'queued-predictions-v1',
        id: request.requestId,
        ownerAddress: request.ownerAddress,
        ownerLock: { codeHash: owner.codeHash, hashType: owner.hashType, args: owner.args },
        createdAt,
        expiresAt: Math.min(createdAt + 120_000, data.expiry - 120_000),
        rawHash: tx.hash(),
        unsignedBytes: tx.toHex(),
        inputs: inputs.map((i) => copyCell(i.cell)),
        parents,
        orderData: data.data,
        capacityShannons: data.capacity.toString(),
        networkFeeShannons: fee.toString(),
        markets,
        ...(request.competitionSelection
          ? { competitionSelection: request.competitionSelection }
          : {}),
      };
      this.store.save({ offer, state: 'offered' });
      return offer;
    });
  }
  async submit(id: string, ownerAddress: string, bytes: string): Promise<OrderStatus> {
    return this.options.journal.exclusive(async () => {
      const row = this.store.load(id);
      if (!row || row.offer.ownerAddress !== ownerAddress)
        throw Error('This payment belongs to another wallet.');
      if (row.state === 'cancelled')
        throw Error('This review was cancelled before acceptance. Start a new review.');
      if (row.signedBytes) {
        if (row.signedBytes !== bytes) throw Error('Payment signature already accepted');
        return this.public(row);
      }
      if (this.now() >= row.offer.expiresAt)
        throw Error('This unsigned review expired. Review the saved picks again.');
      const rows = this.store.all((r) => !terminal(r) && !!r.signedBytes),
        owner = ccc.Script.from(row.offer.ownerLock);
      for (const input of row.offer.inputs) {
        const current = await this.input(input.outPoint, owner, rows);
        if (current.cell.cellOutput.toHex() !== ccc.CellOutput.from(input.cellOutput).toHex())
          throw Error('Funding input changed');
        if (
          rows.some(
            (other) =>
              other.offer.id !== id &&
              other.signedBytes &&
              other.offer.inputs.some((c) => pointKey(c.outPoint) === pointKey(input.outPoint)),
          )
        )
          throw Error('Another accepted payment reserves this funding');
      }
      const historical = orderReservedInputs(
        this.options.journal.directory,
        this.now(),
        row.offer.rawHash,
      );
      for (const input of genesisReservedInputs(this.options.journal.directory, this.now()))
        historical.add(input);
      if (row.offer.inputs.some((c) => historical.has(pointKey(c.outPoint))))
        throw Error('Another accepted payment reserves this funding');
      await verifyOrderSignature(this.options.client, row.offer, bytes);
      this.options.marketPreparation?.assertAcceptable(row.offer.markets);
      row.signedBytes = bytes;
      row.acceptedAt = this.now();
      row.state = 'accepted';
      this.store.save(row);
      return this.public(row);
    });
  }
  status(id: string, owner: string): OrderStatus {
    const row = this.store.load(id);
    if (!row || row.offer.ownerAddress !== owner)
      throw Error('This payment belongs to another wallet.');
    return this.public(row);
  }
  async cancel(id: string, owner: string): Promise<OrderStatus> {
    return this.options.journal.exclusive(async () => {
      const row = this.store.load(id);
      if (!row || row.offer.ownerAddress !== owner)
        throw Error('This payment belongs to another wallet.');
      if (row.signedBytes)
        throw Error('This signed payment is already accepted and will continue automatically.');
      row.state = 'cancelled';
      this.store.save(row);
      return this.public(row);
    });
  }
  private async confirmed(hash: string): Promise<boolean> {
    const response = await this.options.client.getTransactionNoCache(hash);
    if (
      response?.status !== 'committed' ||
      !response.blockHash ||
      response.blockNumber === undefined ||
      response.transaction.hash() !== hash
    )
      return false;
    const header = await this.options.client.getHeaderByNumberNoCache(response.blockNumber),
      tip = await this.options.client.getTipHeader();
    return header?.hash === response.blockHash && tip.number >= response.blockNumber + 3n;
  }
  private async broadcast(bytes: string): Promise<void> {
    const tx = ccc.Transaction.fromBytes(bytes),
      response = await this.options.client.getTransactionNoCache(tx.hash());
    if (response && ['pending', 'proposed', 'committed', 'sent'].includes(response.status)) return;
    const hash = await this.options.client.sendTransactionNoCache(tx, 'passthrough');
    if (hash !== tx.hash()) throw Error('Chain returned another transaction hash');
  }
  private async conflict(
    tx: ccc.Transaction,
    locks: ccc.Script[],
    includeDependencies = false,
    progress?: OrderRecord,
    persist?: (row: OrderRecord) => Promise<void>,
  ): Promise<ccc.Transaction | undefined> {
    const known = await this.options.client.getTransactionNoCache(tx.hash());
    if (known && ['pending', 'proposed', 'committed', 'sent'].includes(known.status)) return;
    // An admission can also become invalid when its market control dependency is
    // consumed by reporting/closing. Prove that spend before replacing its bytes.
    const points = [
      ...tx.inputs.map((i) => i.previousOutput),
      ...(includeDependencies ? tx.cellDeps.map((d) => d.outPoint) : []),
    ];
    const cells = await Promise.all(
      points.map((p) => this.options.client.getCellLiveNoCache(p, false, false)),
    );
    if (cells.every(Boolean)) return;
    const targets = new Set(points.map((p) => p.toHex())),
      seen = new Set<string>();
    if (progress?.conflictHash) {
      const prior = await this.options.client.getTransactionNoCache(progress.conflictHash);
      if (
        prior &&
        prior.transaction.inputs.length <= 64 &&
        prior.transaction.inputs.some((input) => targets.has(input.previousOutput.toHex())) &&
        (await this.confirmed(progress.conflictHash))
      )
        return prior.transaction;
    }
    const uniqueLocks = [...new Map(locks.map((lock) => [lock.hash(), lock])).values()];
    const search = progress?.conflictSearch?.[tx.hash()] ?? { lock: 0 };
    // One bounded page per pass; persist its cursor so a busy lock cannot hide
    // an older conflicting spend forever, including across process restarts.
    const lock = uniqueLocks[search.lock % uniqueLocks.length];
    if (lock) {
      const page = await this.options.client.findTransactionsPaged(
        { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', groupByTransaction: false },
        'desc',
        16,
        search.cursor,
      );
      if (page.transactions.length > 16) throw Error('Conflict history exceeds bounds');
      for (const row of page.transactions) {
        if (!row.isInput || row.txHash === tx.hash() || seen.has(row.txHash)) continue;
        seen.add(row.txHash);
        const candidate = await this.options.client.getTransactionNoCache(row.txHash);
        if (
          candidate &&
          candidate.transaction.inputs.length <= 64 &&
          candidate.transaction.inputs.some((i) => targets.has(i.previousOutput.toHex())) &&
          (await this.confirmed(row.txHash))
        )
          return candidate.transaction;
      }
      if (progress) {
        progress.conflictSearch ??= {};
        progress.conflictSearch[tx.hash()] =
          page.transactions.length === 16 && page.lastCursor !== search.cursor
            ? { lock: search.lock, cursor: page.lastCursor }
            : { lock: (search.lock + 1) % uniqueLocks.length };
        if (persist) await persist(progress);
        else this.store.save(progress);
      }
    }
  }
  private archiveExecution(row: OrderRecord): void {
    if (!row.executionBytes || !row.executionKind) return;
    row.executionHistory ??= [];
    if (row.executionHistory.length >= 32) throw Error('Execution recovery needs operator review');
    row.executionHistory.push({ bytes: row.executionBytes, kind: row.executionKind });
    delete row.executionBytes;
    delete row.executionKind;
  }
  private async failedAncestor(
    row: OrderRecord,
    rows: OrderRecord[],
    seen = new Set<string>(),
    persist?: (row: OrderRecord) => Promise<void>,
    progress = row,
  ): Promise<string | undefined> {
    if (seen.has(row.offer.rawHash) || seen.size >= 3) return;
    seen.add(row.offer.rawHash);
    for (const hash of row.offer.parents) {
      const parent =
        rows.find(
          (p) =>
            p.offer.rawHash === hash &&
            p.signedBytes &&
            ccc.Script.from(p.offer.ownerLock).eq(row.offer.ownerLock),
        ) ?? this.store.byFunding(hash);
      if (
        !parent ||
        !ccc.Script.from(parent.offer.ownerLock).eq(row.offer.ownerLock) ||
        (await this.confirmed(hash))
      )
        continue;
      // A stored conflict hash alone is not proof that this parent cannot fund.
      // Re-read the canonical spender and match the parent's actual inputs.
      const conflict = await this.conflict(
        ccc.Transaction.fromBytes(parent.signedBytes!),
        [ccc.Script.from(parent.offer.ownerLock)],
        false,
        progress,
        persist,
      );
      if (conflict) return conflict.hash();
      const ancestor = await this.failedAncestor(parent, rows, new Set(seen), persist, progress);
      if (ancestor) return ancestor;
    }
  }
  private refund(row: OrderRecord): ccc.Transaction {
    const data = decodeOrder(row.offer.orderData),
      tx = ccc.Transaction.from({
        inputs: [
          {
            previousOutput: { txHash: row.offer.rawHash, index: 0 },
            since: (0x40n << 56n) | ((BigInt(data.expiry) + 999n) / 1000n),
          },
        ],
        outputs: [{ capacity: data.capacity, lock: data.owner }],
        outputsData: ['0x'],
        cellDeps: this.options.config.codeDeps,
        witnesses: ['0x'],
      });
    tx.outputs[0].capacity -= orderFee(tx);
    return tx;
  }
  private async admit(
    row: OrderRecord,
    reserved: Set<string>,
  ): Promise<ccc.Transaction | undefined> {
    const data = decodeOrder(row.offer.orderData),
      tx = ccc.Transaction.from({
        inputs: [{ previousOutput: { txHash: row.offer.rawHash, index: 0 }, since: 0n }],
        cellDeps: this.options.config.codeDeps,
      });
    await readBatch(row.offer.markets, (record) => this.options.validateFixture(record.fixtureId));
    const tip = await this.options.client.getTipHeader();
    for (const [j, record] of row.offer.markets.entries()) {
      const market = await loadOperatorMarket(this.options.client, record, this.options.config);
      if (
        !market.market ||
        market.market.cell.outputData !== '0x0000ff' ||
        market.closed ||
        !(await this.options.client.getCellLiveNoCache(market.market.cell.outPoint, true, true))
      )
        return;
      const lane = market.shards.find((s) => {
        const b = ccc.bytesFrom(s.cell.outputData);
        return (
          b[2] + b[3] < 8 &&
          (!b[3] || s.header.timestamp < BigInt(record.cutoffMs)) &&
          tip.number >= s.header.number + 3n &&
          !reserved.has(s.cell.outPoint.toHex())
        );
      });
      if (!lane || !(await this.options.client.getCellLiveNoCache(lane.cell.outPoint, true, true)))
        return;
      const b = ccc.bytesFrom(lane.cell.outputData),
        line = data.lines[j],
        ticket = new Uint8Array(41);
      ticket.set(ccc.bytesFrom(data.owner.hash()));
      ticket[32] = line.outcome;
      new DataView(ticket.buffer).setBigUint64(33, BigInt(line.principalShannons), true);
      const output = new Uint8Array(b.length + 41);
      output.set(b);
      output[2] = b[2] + b[3];
      output[3] = 1;
      output.set(ticket, b.length);
      tx.inputs.push(ccc.CellInput.from({ previousOutput: lane.cell.outPoint, since: 0n }));
      tx.outputs.push(
        ccc.CellOutput.from({
          ...lane.cell.cellOutput,
          capacity: lane.cell.cellOutput.capacity + ORDER_STORAGE + BigInt(line.principalShannons),
        }),
      );
      tx.outputsData.push(ccc.hexFrom(output));
      tx.cellDeps.push(
        ccc.CellDep.from({ outPoint: market.market.cell.outPoint, depType: 'code' }),
      );
      if (b[3] && !tx.headerDeps.includes(lane.header.hash)) tx.headerDeps.push(lane.header.hash);
    }
    tx.outputs.push(ccc.CellOutput.from({ capacity: ORDER_RESERVE, lock: data.owner }));
    tx.outputsData.push('0x');
    tx.witnesses = tx.inputs.map(() => '0x');
    tx.outputs.at(-1)!.capacity -= orderFee(tx);
    return tx;
  }
  /** Same operator process; a bounded pass resumes without a browser or wallet. */
  async recoverPending(): Promise<void> {
    const selected = await this.options.journal.exclusive(async () => {
      const pending: OrderRecord[] = [],
        checks: string[] = [];
      // Keep at most the bounded active queue plus one historical record in
      // memory. Full transaction histories are streamed, never bulk hydrated.
      for (const row of this.store.scan())
        if (row.signedBytes) {
          if (terminal(row)) checks.push(row.offer.id);
          else pending.push(row);
        }
      pending.sort((a, b) => (a.acceptedAt ?? 0) - (b.acceptedAt ?? 0));
      const offset = this.cursor++;
      return [
        ...Array.from(
          { length: Math.min(pending.length, 3) },
          (_, i) => pending[(offset * 3 + i) % pending.length],
        ),
        ...(checks.length ? [this.store.load(checks[offset % checks.length])!] : []),
      ];
    });
    for (const row of selected) {
      let expected = JSON.stringify(row);
      const persist = async (value: OrderRecord, validate?: () => void) => {
        await this.options.journal.exclusive(async () => {
          if (
            value.offer.id !== row.offer.id ||
            JSON.stringify(this.store.load(row.offer.id)) !== expected
          )
            throw new RecoveryChanged('Another recovery pass changed this order');
          validate?.();
          this.store.save(value);
          expected = JSON.stringify(value);
        });
      };
      try {
        if (
          row.executionBytes &&
          (await this.confirmed(ccc.Transaction.fromBytes(row.executionBytes).hash()))
        ) {
          row.state = row.executionKind === 'refund' ? 'refunded' : 'placed';
          await persist(row);
          await this.options.onObservation?.(row);
          continue;
        }
        if (terminal(row) && row.state !== 'failed') {
          row.state = row.executionKind === 'refund' ? 'refunding' : 'placing';
          await persist(row);
          await this.options.onObservation?.(row);
        }
        if (!(await this.confirmed(row.offer.rawHash))) {
          const funding = ccc.Transaction.fromBytes(row.signedBytes!);
          const blocker = await this.conflict(
            funding,
            [ccc.Script.from(row.offer.ownerLock)],
            false,
            row,
            persist,
          );
          if (blocker) {
            row.state = 'failed';
            row.conflictHash = blocker.hash();
            await persist(row);
            continue;
          }
          const parentFailed = await this.failedAncestor(
            row,
            this.store.all((r) => !!r.signedBytes && !terminal(r)),
            new Set(),
            persist,
          );
          if (parentFailed) {
            row.state = 'failed';
            row.conflictHash = parentFailed;
            await persist(row);
            continue;
          }
          if (row.state === 'failed') {
            // Reopen only after the previous conflict no longer has canonical
            // proof. A stable failure must not emit repeated DB wakeups.
            row.state = 'accepted';
            delete row.conflictHash;
            await persist(row);
            await this.options.onObservation?.(row);
          }
          if (
            row.offer.parents.length &&
            !(await Promise.all(row.offer.parents.map((p) => this.confirmed(p)))).every(Boolean)
          )
            continue;
          row.state = 'funding';
          delete row.conflictHash;
          await persist(row);
          await this.broadcast(row.signedBytes!);
          continue;
        }
        if (row.executionBytes) {
          const execution = ccc.Transaction.fromBytes(row.executionBytes);
          const blocker = await this.conflict(
            execution,
            [
              orderLock(this.options.config.protocolHash, row.offer.orderData),
              ...execution.outputs.flatMap((o) => (o.type ? [o.lock] : [])),
            ],
            true,
            row,
            persist,
          );
          if (blocker) {
            const consumedOrder = blocker.inputs.some((i) =>
              i.previousOutput.eq({ txHash: row.offer.rawHash, index: 0 }),
            );
            this.archiveExecution(row);
            if (consumedOrder) {
              row.executionBytes = blocker.toHex();
              row.executionKind = blocker.outputs.length === 1 ? 'refund' : 'admit';
              row.state = row.executionKind === 'refund' ? 'refunded' : 'placed';
              await persist(row);
              await this.options.onObservation?.(row);
              continue;
            }
            await persist(row);
          } else {
            await persist(row);
            await this.broadcast(row.executionBytes);
            continue;
          }
        }
        row.state = 'waiting';
        await persist(row);
        const reserved = await this.options.journal.exclusive(
          async () =>
            atomicReservations(this.options.journal, this.now(), new Set(), row.offer.id).pending(
              new Set(),
            ).inputs,
        );
        const expired = this.now() >= decodeOrder(row.offer.orderData).expiry;
        if (
          !expired &&
          this.options.marketPreparation &&
          !(await this.options.marketPreparation.ensure(row.offer.markets))
        )
          continue;
        const tx = expired
          ? this.refund(row)
          : admissionDrain(this.options.journal.directory, this.now())
            ? undefined
            : await this.admit(row, reserved);
        if (!tx) continue;
        row.executionBytes = tx.toHex();
        row.executionKind = expired ? 'refund' : 'admit';
        row.state = expired ? 'refunding' : 'placing';
        await persist(row, () => {
          const active = this.store.all((r) => !!r.executionBytes && !terminal(r));
          const unavailable = atomicReservations(
            this.options.journal,
            this.now(),
            new Set(),
            row.offer.id,
          ).pending(new Set()).inputs;
          if (
            active.length >= 3 ||
            tx.inputs.some((i) => unavailable.has(i.previousOutput.toHex())) ||
            (!expired &&
              (this.now() >= decodeOrder(row.offer.orderData).expiry ||
                admissionDrain(this.options.journal.directory, this.now())))
          )
            throw new RecoveryChanged('Execution resources changed during preparation');
        });
        await this.broadcast(tx.toHex());
      } catch (error) {
        if (error instanceof RecoveryChanged) continue;
        // Unknown outcomes never release inputs or invent a replacement authorization.
        const retained = this.store.load(row.offer.id);
        if (!retained || JSON.stringify(retained) !== expected) continue;
        retained.message =
          'Processing will retry. Original funding and execution bytes are retained.';
        try {
          await persist(retained);
        } catch (saveError) {
          if (!(saveError instanceof RecoveryChanged)) throw saveError;
        }
      }
    }
  }
}
