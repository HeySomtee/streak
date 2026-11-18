import * as ccc from '@ckb-ccc/core';
import { readdirSync } from 'node:fs';
import type { Match } from '../../types';
import { DirectRegistry, type DirectMarketRecord, type DirectProtocolConfig } from './registry';
import {
  OperatorJournal,
  OPERATION_FILE,
  broadcastOperation,
  reconcileOperation,
  type SignedOperation,
} from './journal';
import { assertFreshOperatorInputs, assertQueuedCreationAvailable } from './cli';
import { buildQueuedCreates, MARKET_RESERVE_SHANNONS } from './operator';
import { commitQueuedFixtures, parseQueuedFixtureIds } from './queued-fixtures';
import { sponsorStores } from './sponsor-journal';
import { GenesisPlans } from './genesis-plans';

/** Shared immutable genesis preparation. Never spends a user's funding input. */
export class OrderMarkets {
  constructor(
    readonly options: {
      client: ccc.Client;
      signer: ccc.Signer;
      journal: OperatorJournal;
      registry: DirectRegistry;
      earlier: DirectRegistry[];
      config: DirectProtocolConfig;
      fixtures: (ids: string[]) => Promise<Match[]>;
      now?: () => number;
    },
  ) {}
  private plans() {
    return new GenesisPlans(this.options.journal.directory);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private operations(): SignedOperation[] {
    const files = readdirSync(this.options.journal.directory).filter((f) => OPERATION_FILE.test(f));
    if (files.length > 1536) throw Error('Operator journal exceeds its reviewed bound');
    return files.map((f) => this.options.journal.load(f.slice(0, -5))!);
  }
  private creations() {
    return this.operations().filter(
      (o) =>
        o.action === 'create' && o.descriptor.type.codeHash === this.options.config.protocolHash,
    );
  }
  get(id: string): DirectMarketRecord | undefined {
    return (
      this.options.registry.get(id) ??
      this.creations()
        .flatMap((o) => o.creations ?? [o.descriptor])
        .find((r) => r.fixtureId === id) ??
      this.plans()
        .active(this.now())
        .flatMap((p) => p.records)
        .find((r) => r.fixtureId === id)
    );
  }
  legacyFixtureIds(): string[] {
    const ids = new Set(
      this.options.earlier
        .flatMap((r) => r.all())
        .filter((r) => r.cutoffMs > this.now())
        .map((r) => r.fixtureId),
    );
    for (const op of this.operations())
      if (op.descriptor.type.codeHash !== this.options.config.protocolHash)
        for (const r of op.creations ?? [op.descriptor])
          if (r.cutoffMs > this.now()) ids.add(r.fixtureId);
    for (const store of sponsorStores(this.options.journal.directory))
      for (const row of store.all()) {
        if (
          !row.userSignedBytes &&
          !row.signedBytes &&
          (row.state === 'cancelled' || row.offer.expiresAt <= this.now())
        )
          continue;
        const offer = row.offer as typeof row.offer & {
          lines?: { mode: string; fixture: { fixtureId: string } }[];
        };
        for (const id of offer.lines
          ? offer.lines.filter((l) => l.mode === 'create').map((l) => l.fixture.fixtureId)
          : [offer.fixture.fixtureId])
          ids.add(id);
      }
    if (ids.size > 512) throw Error('Market routing exceeds its reviewed bound');
    return [...ids];
  }
  async prepare(value: unknown, owner: string): Promise<DirectMarketRecord[]> {
    const ids = parseQueuedFixtureIds(value);
    if (!ids.length || ids.length > 8) throw Error('Choose one to eight fixtures');
    // Provider reads happen before the short cross-process mutation lease.
    const fixtures = await this.options.fixtures(ids);
    if (fixtures.length !== ids.length || fixtures.some((f, i) => f.id !== ids[i]))
      throw Error('Fixture catalogue changed');
    return this.options.journal.exclusive(async () => {
      for (const id of ids)
        assertQueuedCreationAvailable(
          id,
          this.options.journal,
          this.options.earlier,
          this.options.config.protocolHash,
        );
      const plans = this.plans(),
        active = plans.active(this.now());
      const missing = fixtures.filter((f) => !this.get(f.id));
      if (
        missing.length &&
        (active.filter((p) => !plans.signed(p)).length >= 128 ||
          active.filter((p) => p.owner === owner && !plans.signed(p)).length >= 3)
      )
        throw Error('Finish or cancel an open review before starting another.');
      if (missing.length) {
        const fund = await this.funding(missing.length);
        const built = await buildQueuedCreates(
          this.options.client,
          this.options.signer,
          missing,
          fund,
          this.now(),
          this.options.config,
        );
        assertFreshOperatorInputs(this.options.journal, built.tx);
        plans.save({
          version: 1,
          hash: built.tx.hash(),
          unsignedBytes: built.tx.toHex(),
          records: built.records,
          owner,
          expiresAt: this.now() + 300_000,
        });
      }
      for (const p of active.filter((p) => p.records.some((r) => ids.includes(r.fixtureId)))) {
        p.expiresAt = this.now() + 300_000;
        plans.save(p);
      }
      commitQueuedFixtures(this.options.journal.directory, ids);
      return ids.map((id) => this.get(id)!);
    });
  }
  private async funding(count: number): Promise<ccc.Cell> {
    const { client, signer, journal } = this.options;
    const lock = (await signer.getRecommendedAddressObj()).script;
    const minimum =
      MARKET_RESERVE_SHANNONS * BigInt(count) +
      BigInt(ccc.CellOutput.from({ capacity: 0n, lock }).occupiedSize) * 100_000_000n +
      100_000_000n;
    const fresh = (cell: ccc.Cell) => {
      if (
        cell.cellOutput.type ||
        cell.outputData !== '0x' ||
        !cell.cellOutput.lock.eq(lock) ||
        cell.cellOutput.capacity < minimum
      )
        return false;
      try {
        assertFreshOperatorInputs(
          journal,
          ccc.Transaction.from({ inputs: [{ previousOutput: cell.outPoint }] }),
        );
        return true;
      } catch {
        return false;
      }
    };
    const page = await client.findCellsPagedNoCache(
      { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', withData: true },
      'desc',
      64,
    );
    for (const candidate of page.cells
      .filter(fresh)
      .sort((a, b) => (a.cellOutput.capacity > b.cellOutput.capacity ? -1 : 1))
      .slice(0, 4)) {
      const live = await client.getCellLiveNoCache(candidate.outPoint, true, true);
      const origin = await client.getTransactionNoCache(candidate.outPoint.txHash);
      if (
        !live ||
        !fresh(live) ||
        !origin ||
        origin.status !== 'committed' ||
        origin.blockNumber === undefined ||
        !origin.blockHash
      )
        continue;
      const header = await client.getHeaderByNumberNoCache(origin.blockNumber),
        tip = await client.getTipHeader();
      if (header?.hash === origin.blockHash && tip.number >= origin.blockNumber + 3n) return live;
    }
    // Different new slips can use exact signed genesis change, at most three
    // unconfirmed batches. A batch contains up to eight fixtures, not eight hops.
    const operations = this.creations();
    for (const plan of this.plans().active(this.now()))
      if (!operations.some((o) => o.transactionHash === plan.hash))
        operations.push({
          version: 1,
          action: 'create',
          operationId: 'unsigned',
          fixtureId: plan.records[0].fixtureId,
          createdAtMs: 0,
          transactionHash: plan.hash,
          signedTransaction: plan.unsignedBytes,
          descriptor: plan.records[0],
          creations: plan.records,
        });
    const byHash = new Map(operations.map((o) => [o.transactionHash, o]));
    const depth = async (op: SignedOperation, seen = new Set<string>()): Promise<number> => {
      if (seen.has(op.transactionHash) || seen.size >= 3) return 4;
      const state = await reconcileOperation(client, op);
      if (state.status === 'committed' && (state.confirmations ?? 0) >= 4) return 0;
      if (
        state.status === 'rejected' ||
        (op.creations ?? [op.descriptor]).some((r) => r.cutoffMs <= this.now() + 120_000)
      )
        return 4;
      seen.add(op.transactionHash);
      const input = ccc.Transaction.fromBytes(op.signedTransaction).inputs[0].previousOutput;
      const parent = byHash.get(input.txHash);
      if (state.status === 'uncertain') {
        const parentState = parent ? await reconcileOperation(client, parent) : undefined;
        if (!parent || parentState?.status === 'committed') {
          if (!(await client.getCellLiveNoCache(input, true, true))) return 4;
        }
      }
      return 1 + (parent ? await depth(parent, seen) : 0);
    };
    for (const op of operations.slice().reverse()) {
      const tx = ccc.Transaction.fromBytes(op.signedTransaction),
        index = tx.outputs.length - 1;
      const change = ccc.Cell.from({
        outPoint: { txHash: tx.hash(), index },
        cellOutput: tx.outputs[index],
        outputData: tx.outputsData[index],
      });
      if (!fresh(change)) continue;
      const state = await reconcileOperation(client, op);
      if (state.status === 'committed') {
        const live = await client.getCellLiveNoCache(change.outPoint, true, true);
        if (
          live &&
          live.cellOutput.toHex() === change.cellOutput.toHex() &&
          live.outputData === '0x' &&
          (state.confirmations ?? 0) >= 4
        )
          return live;
        continue;
      }
      if (state.status !== 'rejected' && (await depth(op)) < 3) return change;
    }
    throw Error(
      'Streak needs additional testnet capacity to prepare these new markets. Your picks are saved.',
    );
  }
  /** Called under the shared lease immediately before durable owner acceptance. */
  assertAcceptable(records: DirectMarketRecord[]): void {
    for (const record of records) {
      const current = this.get(record.fixtureId);
      if (!current || JSON.stringify(current) !== JSON.stringify(record))
        throw Error('This unsigned review expired. Review the saved picks again.');
    }
  }
  private async promote(records: DirectMarketRecord[]): Promise<void> {
    await this.options.journal.exclusive(async () => {
      const plans = this.plans().active(this.now()),
        byHash = new Map(plans.map((p) => [p.hash, p]));
      const existing = new Map(this.creations().map((o) => [o.transactionHash, o]));
      const signed = new Set(existing.keys());
      const visit = async (hash: string, seen = new Set<string>()): Promise<void> => {
        if (signed.has(hash)) return;
        if (seen.has(hash)) throw Error('Cyclic genesis ancestry');
        const plan = byHash.get(hash);
        if (!plan) return;
        if (seen.size >= 3) throw Error('Invalid genesis ancestry');
        seen.add(hash);
        const tx = ccc.Transaction.fromBytes(plan.unsignedBytes);
        await visit(tx.inputs[0].previousOutput.txHash, seen);
        const parent = byHash.get(tx.inputs[0].previousOutput.txHash);
        const signedParent = existing.get(tx.inputs[0].previousOutput.txHash);
        const parentBytes = parent?.unsignedBytes ?? signedParent?.signedTransaction;
        const cell = parentBytes
          ? ccc.Transaction.fromBytes(parentBytes).getOutput(tx.inputs[0].previousOutput.index)
          : await this.options.client.getCellLiveNoCache(tx.inputs[0].previousOutput, true, true);
        if (!cell) throw Error('Genesis funding is unavailable');
        tx.inputs[0].cellOutput = cell.cellOutput;
        tx.inputs[0].outputData = cell.outputData;
        assertFreshOperatorInputs(this.options.journal, tx, hash);
        const authorized = await this.options.signer.signTransaction(tx);
        if (authorized.hash() !== hash) throw Error('Genesis signature changed its immutable hash');
        this.options.journal.persist(
          'create',
          plan.records[0],
          authorized,
          this.now(),
          plan.records,
        );
        signed.add(hash);
      };
      for (const record of records) await visit(record.creationTxHash);
    });
  }
  /** Called for funded orders, never for a page visit or an unsigned review. */
  async ensure(records: DirectMarketRecord[]): Promise<boolean> {
    await this.promote(records);
    const operations = this.creations(),
      byHash = new Map(operations.map((o) => [o.transactionHash, o]));
    const done = new Map<string, boolean>();
    const visit = async (hash: string, seen = new Set<string>()): Promise<boolean> => {
      if (done.has(hash)) return done.get(hash)!;
      if (seen.has(hash)) throw Error('Cyclic genesis dependency chain');
      const op = byHash.get(hash);
      if (!op) return true; // Existing canonical market created by the earlier CLI.
      const already = await reconcileOperation(this.options.client, op);
      if (already.status === 'committed' && (already.confirmations ?? 0) >= 4) {
        await this.options.journal.exclusive(async () => {
          for (const r of op.creations ?? [op.descriptor])
            await this.options.registry.publishCanonical(r, this.options.client);
        });
        done.set(hash, true);
        return true;
      }
      if (seen.size >= 3) throw Error('Invalid genesis dependency chain');
      seen.add(hash);
      const parentHash = ccc.Transaction.fromBytes(op.signedTransaction).inputs[0].previousOutput
        .txHash;
      if (byHash.has(parentHash) && !(await visit(parentHash, seen))) return false;
      // Exact journaled bytes only; RPC confirmation never holds the foreground lease.
      const state = await broadcastOperation(
        this.options.client,
        this.options.journal,
        op,
        this.now(),
      );
      const confirmed = state.status === 'committed' && (state.confirmations ?? 0) >= 4;
      if (confirmed)
        await this.options.journal.exclusive(async () => {
          for (const r of op.creations ?? [op.descriptor])
            await this.options.registry.publishCanonical(r, this.options.client);
        });
      done.set(hash, confirmed);
      return confirmed;
    };
    let ready = true;
    for (const record of records) if (!(await visit(record.creationTxHash))) ready = false;
    return ready;
  }
}
