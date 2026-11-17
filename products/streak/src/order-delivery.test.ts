import assert from 'node:assert/strict';
import * as ccc from '@ckb-ccc/core';
import { prepareOrderEvents } from './modules/activity/order-delivery';
import type { ActivityPublicEvent } from './modules/activity/events';
import { regularOnlySelection } from './modules/campaigns/entry-payments';

async function main() {
  const hash = `0x${'12'.repeat(32)}`;
  const tx = ccc.Transaction.from({ inputs: [], outputs: [], outputsData: [] });
  const event = {
    id: hash,
    kind: 'payment',
    state: 'funded',
    transactionHash: tx.hash(),
    order: { offerId: '00000000-0000-0000-0000-000000000000', fundingHash: hash, revision: 1 },
  } as ActivityPublicEvent;
  const healthy = { ...event, id: `0x${'13'.repeat(32)}`, order: undefined };
  const batch = { events: [event, healthy], hasMore: true };
  let visible = false,
    canonical = true,
    depth = 3n,
    binds = 0,
    fail = false;
  const header = (number: bigint) =>
    ccc.ClientBlockHeader.from({
      number,
      hash,
      compactTarget: 0,
      dao: { c: 0, ar: 0, s: 0, u: 0 },
      epoch: [0, 0, 1],
      extraHash: hash,
      nonce: 0,
      parentHash: hash,
      proposalsHash: hash,
      timestamp: 1800000000000,
      transactionsRoot: hash,
      version: 0,
    });
  const client = {
    getTransactionNoCache: async () =>
      visible
        ? ccc.ClientTransactionResponse.from({
            transaction: tx,
            status: 'committed',
            blockHash: hash,
            blockNumber: 1,
          })
        : undefined,
    getHeaderByNumberNoCache: async () => (canonical ? header(1n) : undefined),
    getTipHeader: async () => header(depth),
  };
  const bind = async () => {
    if (fail) throw Error('Database unavailable');
    binds++;
  };
  for (const phase of ['missing', 'shallow', 'orphan', 'database', 'ready']) {
    visible = phase !== 'missing';
    canonical = phase !== 'orphan';
    depth = phase === 'shallow' ? 3n : 4n;
    fail = phase === 'database';
    const result = await prepareOrderEvents(batch, client, bind);
    assert.deepEqual(
      result.events.map((e) => e.id),
      phase === 'ready' ? [event.id, healthy.id] : [healthy.id],
    );
    if (phase !== 'ready')
      assert.equal(result.hasMore, false, 'Retry waits without a busy drain loop');
  }
  assert.equal(binds, 1, 'Only verified and durably bound events become acknowledgeable');
  canonical = false;
  assert.equal((await prepareOrderEvents(batch, client, bind)).events.length, 1);
  canonical = true;
  assert.equal((await prepareOrderEvents(batch, client, bind)).events.length, 2);
  assert.equal(binds, 2, 'Reconfirmation retries binding for the same execution');
  assert(
    regularOnlySelection({ accountId: 'a', lines: [{ fixtureId: 'f', campaignIds: [] }] }, 'a'),
  );
  assert(
    !regularOnlySelection({ accountId: 'a', lines: [{ fixtureId: 'f', campaignIds: ['c'] }] }, 'a'),
  );
  assert(
    !regularOnlySelection({ accountId: 'b', lines: [{ fixtureId: 'f', campaignIds: [] }] }, 'a'),
  );
  assert(!regularOnlySelection({ accountId: 'a', lines: [null] }, 'a'));
  console.log(
    'Order delivery preserves unverified events, reorg retry, healthy delivery and regular-only choices',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
