/* Synthetic recovery transport, called by the owned browser fixture. */
const assert = require('node:assert/strict');
const ccc = require('@ckb-ccc/core');
const { OrderService } = require('../src/modules/direct/order-service.ts');
const { ActivityEventOutbox } = require('../src/modules/activity/outbox.ts');
const { OperatorJournal } = require('../src/modules/direct/journal.ts');
module.exports = async function checkRecovery(service, owner) {
  const original = service.store.all((r) => Boolean(r.signedBytes))[0];
  const row = structuredClone(original),
    tx = ccc.Transaction.fromBytes(row.signedBytes);
  const spender = ccc.Transaction.from({
    inputs: [{ previousOutput: tx.inputs[0].previousOutput }],
    outputs: [{ capacity: 10000000000n, lock: owner }],
    outputsData: ['0x'],
  });
  const client = service.options.client;
  const names = [
    'getTransactionNoCache',
    'getCellLiveNoCache',
    'findTransactionsPaged',
    'getHeaderByNumberNoCache',
    'getTipHeader',
  ];
  const methods = Object.fromEntries(names.map((name) => [name, client[name]]));
  const header = await client.getTipHeader();
  const cursors = [];
  try {
    client.getTransactionNoCache = async (hash) =>
      hash === spender.hash()
        ? {
            transaction: spender,
            status: 'committed',
            blockHash: header.hash,
            blockNumber: header.number,
          }
        : undefined;
    client.getCellLiveNoCache = async () => undefined;
    client.getHeaderByNumberNoCache = async () => header;
    client.getTipHeader = async () => ({ ...header, number: header.number + 3n });
    client.findTransactionsPaged = async (_key, _order, _limit, cursor) => {
      cursors.push(cursor);
      return cursor === '0x01'
        ? { transactions: [{ isInput: true, txHash: spender.hash() }], lastCursor: '0x02' }
        : {
            transactions: Array.from({ length: 16 }, () => ({ isInput: false, txHash: tx.hash() })),
            lastCursor: '0x01',
          };
    };
    assert.equal(await service.conflict(tx, [owner], false, row), undefined);
    service = new OrderService(service.options);
    const resumed = service.store.load(row.offer.id);
    assert.equal((await service.conflict(tx, [owner], false, resumed)).hash(), spender.hash());
    assert.deepEqual(
      cursors,
      [undefined, '0x01'],
      'Recovery advances past the first page after restart',
    );
    assert.equal(resumed.signedBytes, original.signedBytes);
    const stable = new OrderService({
      ...service.options,
      journal: new OperatorJournal(
        require('node:path').join(service.options.journal.directory, 'stable-failure'),
      ),
    });
    stable.store.save({ ...resumed, state: 'failed', conflictHash: spender.hash() });
    const revision = stable.store.load(row.offer.id).observationRevision;
    let unexpectedPageReads = 0;
    client.findTransactionsPaged = async () => {
      unexpectedPageReads += 1;
      throw Error('New wallet history shifted the known spender beyond the saved page');
    };
    await stable.recoverPending();
    await stable.recoverPending();
    assert.equal(unexpectedPageReads, 0, 'Known canonical conflict is revalidated directly');
    assert.equal(stable.status(row.offer.id, row.offer.ownerAddress).state, 'failed');
    assert.equal(
      stable.store.load(row.offer.id).observationRevision,
      revision,
      'A still-canonical failure does not invent placing states or repeat scoring deliveries',
    );
  } finally {
    for (const name of names) client[name] = methods[name];
  }
  const shard = Buffer.alloc(45);
  shard.set([1, 0, 0, 1]);
  Buffer.from(owner.hash().slice(2), 'hex').copy(shard, 4);
  shard[36] = 0;
  shard.writeBigUInt64LE(10000000000n, 37);
  const admission = ccc.Transaction.from({
    inputs: [{ previousOutput: { txHash: row.offer.rawHash, index: 0 } }],
    outputs: [{ capacity: 103100000000n, lock: owner, type: row.offer.markets[0].type }],
    outputsData: [ccc.hexFrom(shard)],
  });
  const update = (state) =>
    service.store.save({
      ...service.store.load(row.offer.id),
      executionBytes: admission.toHex(),
      executionKind: 'admit',
      state,
    });
  let relay = new ActivityEventOutbox(service.options.journal);
  const read = () => {
    const batch = relay.read();
    return batch.events.filter((event) => event.order?.offerId === row.offer.id);
  };
  try {
    update('placed');
    const first = read().find((e) => e.state === 'funded');
    assert(first);
    relay.acknowledge({ ids: [first.id] });
    update('placing');
    assert(read().some((e) => e.state === 'confirming'));
    update('placed');
    relay.close();
    relay = new ActivityEventOutbox(service.options.journal);
    const again = read();
    assert.equal(again.length, 1, 'Superseded observations are not delivered');
    assert.equal(again[0].state, 'funded');
    assert.notEqual(
      again[0].id,
      first.id,
      'Reconfirmation after a reorg has a fresh durable identity',
    );
    relay.acknowledge({ ids: [again[0].id] });
    assert.equal(read().length, 0, 'Stable observation does not flood new events');
  } finally {
    relay.close();
    service.store.save(original);
  }
  console.log(
    'Order recovery: older conflict pagination, restart and durable re-confirmation events passed',
  );
};
