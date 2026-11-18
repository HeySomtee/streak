import { decodeOrder } from '../../../shared/order-codec.mjs';
import * as ccc from '@ckb-ccc/core';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OrderStore } from './order-store';
import {
  V5_DIRECT_CONFIG,
  validateRecord,
  writeExclusiveJson,
  type DirectMarketRecord,
} from './registry';

export interface GenesisPlan {
  version: 1;
  hash: string;
  unsignedBytes: string;
  records: DirectMarketRecord[];
  owner: string;
  expiresAt: number;
}
/** Unsigned setup leases. An accepted order pins its whole exact ancestry. */
export class GenesisPlans {
  readonly directory: string;
  constructor(readonly operatorDirectory: string) {
    this.directory = join(operatorDirectory, 'genesis-plans-v5');
  }
  all(): GenesisPlan[] {
    if (!existsSync(this.directory)) return [];
    const files = readdirSync(this.directory).filter((f) => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length > 4096) throw Error('Genesis plan history exceeds its bound');
    return files.map((file) => {
      const path = join(this.directory, file);
      if (statSync(path).size > 200_000) throw Error('Genesis plan exceeds its byte bound');
      const p: GenesisPlan = JSON.parse(readFileSync(path, 'utf8'));
      if (
        p.version !== 1 ||
        p.hash !== '0x' + file.slice(0, -5) ||
        typeof p.owner !== 'string' ||
        p.owner.length > 300 ||
        !Number.isSafeInteger(p.expiresAt) ||
        !Array.isArray(p.records) ||
        !p.records.length ||
        p.records.length > 8
      )
        throw Error('Invalid genesis plan');
      const tx = ccc.Transaction.fromBytes(p.unsignedBytes);
      if (
        tx.hash() !== p.hash ||
        tx.inputs.length !== 1 ||
        tx.outputs.length !== p.records.length * 5 + 1 ||
        new Set(p.records.map((r) => r.fixtureId)).size !== p.records.length
      )
        throw Error('Invalid genesis transaction');
      p.records.forEach((r, i) => {
        validateRecord(r, V5_DIRECT_CONFIG);
        if (
          r.type.codeHash !== V5_DIRECT_CONFIG.protocolHash ||
          r.creationTxHash !== p.hash ||
          !tx.outputs[i * 5].type?.eq(r.type) ||
          tx.outputsData[i * 5] !== '0x0000ff'
        )
          throw Error('Invalid genesis binding');
      });
      return p;
    });
  }
  signed(plan: GenesisPlan): boolean {
    return existsSync(
      join(
        this.operatorDirectory,
        `create-v5-${plan.records[0].fixtureId}-${plan.hash.slice(2)}.json`,
      ),
    );
  }
  active(now: number): GenesisPlan[] {
    const all = this.all(),
      byHash = new Map(all.map((p) => [p.hash, p]));
    const held = new Set(all.filter((p) => p.expiresAt > now || this.signed(p)).map((p) => p.hash));
    if (existsSync(join(this.operatorDirectory, 'orders-v5')))
      for (const row of new OrderStore(
        this.operatorDirectory,
        V5_DIRECT_CONFIG.protocolHash,
      ).scan())
        if (row.signedBytes && decodeOrder(row.offer.orderData).expiry > now)
          for (const market of row.offer.markets) held.add(market.creationTxHash);
    const visit = (hash: string, seen = new Set<string>()) => {
      if (seen.has(hash) || seen.size > 4096) throw Error('Cyclic genesis ancestry');
      const p = byHash.get(hash);
      if (!p) return;
      seen.add(hash);
      held.add(hash);
      visit(ccc.Transaction.fromBytes(p.unsignedBytes).inputs[0].previousOutput.txHash, seen);
    };
    for (const hash of [...held]) visit(hash);
    return all.filter((p) => held.has(p.hash));
  }
  save(plan: GenesisPlan): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (
      this.all().length >= 4096 &&
      !existsSync(join(this.directory, plan.hash.slice(2) + '.json'))
    )
      throw Error('Genesis plan history is full');
    const file = join(this.directory, plan.hash.slice(2) + '.json'),
      temp = file + '.' + randomUUID() + '.next';
    writeExclusiveJson(temp, plan);
    renameSync(temp, file);
    if (process.platform !== 'win32') {
      const d = openSync(this.directory, 'r');
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    }
  }
}
export function genesisReservedInputs(
  directory: string,
  now: number,
  exceptHash?: string,
): Set<string> {
  const held = new Set(
    new GenesisPlans(directory)
      .active(now)
      .filter((p) => p.hash !== exceptHash)
      .flatMap((p) =>
        ccc.Transaction.fromBytes(p.unsignedBytes).inputs.map((i) => i.previousOutput.toHex()),
      ),
  );
  // Signed CLI genesis may predate plans; its inputs remain reserved too.
  const files = readdirSync(directory).filter((f) =>
    /^create-v5-api-football-[1-9][0-9]{0,14}-[0-9a-f]{64}\.json$/.test(f),
  );
  if (files.length > 1536) throw Error('Genesis journal exceeds its bound');
  for (const file of files) {
    const path = join(directory, file);
    if (statSync(path).size > 300_000) throw Error('Genesis journal exceeds its byte bound');
    const row = JSON.parse(readFileSync(path, 'utf8'));
    const tx = ccc.Transaction.fromBytes(row.signedTransaction);
    if (tx.hash() !== row.transactionHash) throw Error('Genesis journal differs from its hash');
    if (tx.hash() !== exceptHash)
      for (const input of tx.inputs) held.add(input.previousOutput.toHex());
  }
  return held;
}
