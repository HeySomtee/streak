import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ccc from '@ckb-ccc/core';
import { ORDER_PROTOCOL_HASH } from '../../../shared/order-codec.mjs';
import { OrderStore } from './order-store';

/** All payment paths share durable reservations, including signed offline orders. */
export function orderReservedInputs(
  directory: string,
  now = Date.now(),
  excludeHash?: string,
  excludeOrderId?: string,
): Set<string> {
  const inputs = new Set<string>();
  if (!existsSync(join(directory, 'orders-v5'))) return inputs;
  for (const row of new OrderStore(directory, ORDER_PROTOCOL_HASH).scan()) {
    if (row.offer.id === excludeOrderId) continue;
    if (
      row.offer.rawHash !== excludeHash &&
      row.state !== 'cancelled' &&
      (row.signedBytes || row.offer.expiresAt > now)
    )
      for (const cell of row.offer.inputs) inputs.add(ccc.OutPoint.from(cell.outPoint).toHex());
    for (const bytes of [row.executionBytes, ...(row.executionHistory ?? []).map((e) => e.bytes)]) {
      if (!bytes) continue;
      const tx = ccc.Transaction.fromBytes(bytes);
      if (tx.hash() === excludeHash) continue;
      for (const input of tx.inputs) inputs.add(input.previousOutput.toHex());
    }
  }
  return inputs;
}
