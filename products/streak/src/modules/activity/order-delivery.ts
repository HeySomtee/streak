import type * as ccc from '@ckb-ccc/core';
import type { ActivityEventBatch, ActivityPublicEvent } from './events';

/** Unverified deliveries remain in the durable outbox, without blocking healthy events. */
export async function prepareOrderEvents(
  batch: ActivityEventBatch,
  client: Pick<ccc.Client, 'getTransactionNoCache' | 'getHeaderByNumberNoCache' | 'getTipHeader'>,
  bind: (event: ActivityPublicEvent) => Promise<void>,
): Promise<ActivityEventBatch> {
  const events: ActivityPublicEvent[] = [];
  let withheld = false;
  for (const event of batch.events) {
    if (!event.order) {
      events.push(event);
      continue;
    }
    try {
      if (event.state !== 'confirming') {
        const tx = await client.getTransactionNoCache(event.transactionHash);
        if (!(
          tx?.status === 'committed' &&
          tx.transaction.hash() === event.transactionHash &&
          tx.blockHash &&
          tx.blockNumber !== undefined &&
          (await client.getHeaderByNumberNoCache(tx.blockNumber))?.hash === tx.blockHash &&
          (await client.getTipHeader()).number >= tx.blockNumber + 3n
        )) {
          withheld = true;
          continue;
        }
      }
      await bind(event);
      events.push(event);
    } catch {
      withheld = true;
    }
  }
  return {
    events,
    hasMore: withheld ? false : batch.hasMore,
    degraded: withheld || batch.degraded,
  };
}
