import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import * as ccc from '@ckb-ccc/core';
import { writeExclusiveJson } from './registry';
import { validateOrderOffer, decodeOrder } from '../../../shared/order-codec.mjs';
import type { OrderRecord } from '../../../shared/order-wire';

export class OrderStore {
  readonly directory: string;
  constructor(
    directory: string,
    readonly protocolHash: string,
  ) {
    this.directory = join(directory, 'orders-v5');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private path(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw Error('Invalid order identity');
    return join(this.directory, `${id}.json`);
  }
  validate(row: OrderRecord): OrderRecord {
    if (
      !row ||
      row.offer?.version !== 'queued-predictions-v1' ||
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
      ].includes(row.state)
    )
      throw Error('Invalid saved order');
    if (row.state === 'cancelled' && row.signedBytes)
      throw Error('An accepted order cannot be cancelled');
    const o = validateOrderOffer(row.offer, this.protocolHash);
    const selection = `0x${createHash('sha256')
      .update(JSON.stringify(o.competitionSelection ?? null))
      .digest('hex')}`;
    if (decodeOrder(o.orderData).selectionDigest !== selection)
      throw Error('Saved competition choices differ from the signed order');
    if (
      row.signedBytes &&
      (!Number.isSafeInteger(row.acceptedAt) ||
        row.acceptedAt! < o.createdAt ||
        row.acceptedAt! >= o.expiresAt)
    )
      throw Error('Invalid server acceptance time');
    if (row.executionBytes && !['admit', 'refund'].includes(row.executionKind ?? ''))
      throw Error('Invalid execution kind');
    if (row.signedBytes && ccc.Transaction.fromBytes(row.signedBytes).hash() !== o.rawHash)
      throw Error('Saved order signature changes its transaction');
    if (row.executionBytes && !row.signedBytes) throw Error('Execution has no accepted funding');
    if (
      row.observationRevision !== undefined &&
      (!Number.isSafeInteger(row.observationRevision) || row.observationRevision < 1)
    )
      throw Error('Invalid order observation revision');
    if (row.conflictSearch) {
      const searches = Object.entries(row.conflictSearch);
      if (
        searches.length > 40 ||
        searches.some(
          ([hash, search]) =>
            !/^0x[0-9a-f]{64}$/.test(hash) ||
            !Number.isSafeInteger(search.lock) ||
            search.lock < 0 ||
            search.lock > 8 ||
            (search.cursor !== undefined && !/^0x[0-9a-f]{0,2048}$/.test(search.cursor)),
        )
      )
        throw Error('Invalid bounded conflict search');
    }
    if (
      (row.executionHistory?.length ?? 0) > 32 ||
      (row.conflictHash && !/^0x[0-9a-f]{64}$/.test(row.conflictHash))
    )
      throw Error('Invalid order recovery history');
    for (const execution of [
      row.executionBytes,
      ...(row.executionHistory ?? []).map((e) => e.bytes),
    ].filter((s): s is string => !!s)) {
      const t = ccc.Transaction.fromBytes(execution);
      if (!t.inputs[0]?.previousOutput.eq({ txHash: o.rawHash, index: 0 }))
        throw Error('Saved execution spends another order');
    }
    return row;
  }
  load(id: string): OrderRecord | undefined {
    const file = this.path(id);
    if (!existsSync(file)) return;
    if (statSync(file).size > 300_000) throw Error('Saved order exceeds its bound');
    return this.validate(JSON.parse(readFileSync(file, 'utf8')) as OrderRecord);
  }
  ids(): string[] {
    const files = readdirSync(this.directory).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f));
    if (files.length > 4096) throw Error('Order journal reached its history limit');
    return files.sort().map((f) => f.slice(0, -5));
  }
  *scan(): Generator<OrderRecord> {
    for (const id of this.ids()) {
      const row = this.load(id);
      if (row) yield row;
    }
  }
  byFunding(hash: string): OrderRecord | undefined {
    for (const row of this.scan()) if (row.offer.rawHash === hash && row.signedBytes) return row;
  }
  all(keep: (row: OrderRecord) => boolean = () => true): OrderRecord[] {
    const rows: OrderRecord[] = [];
    for (const row of this.scan()) if (keep(row)) rows.push(row);
    return rows;
  }
  save(row: OrderRecord): void {
    this.validate(row);
    const old = this.load(row.offer.id);
    const observation = (r: OrderRecord) =>
      JSON.stringify([r.state, r.executionBytes, r.conflictHash]);
    row.observationRevision =
      (old?.observationRevision ?? 0) + (!old || observation(old) !== observation(row) ? 1 : 0);
    this.validate(row);
    if (Buffer.byteLength(JSON.stringify(row, null, 2) + '\n') > 300_000)
      throw Error('Saved order exceeds its bound');
    if (old && JSON.stringify(old) === JSON.stringify(row)) return;
    if (old?.state === 'cancelled') throw Error('A cancelled review cannot be accepted later');
    if (
      old &&
      (JSON.stringify(old.offer) !== JSON.stringify(row.offer) ||
        (old.signedBytes && old.signedBytes !== row.signedBytes))
    )
      throw Error('An immutable order cannot be replaced');
    const file = this.path(row.offer.id);
    if (!old && this.ids().length >= 4096) throw Error('Order journal reached its history limit');
    const temp = `${file}.${randomUUID()}.next`;
    writeExclusiveJson(temp, row);
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const directory = openSync(this.directory, 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  }
}
