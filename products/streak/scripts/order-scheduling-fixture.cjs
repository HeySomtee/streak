/* Isolated signed fixtures. Exercise scheduling without a public node or wallet. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ccc = require('@ckb-ccc/core');
const { OrderService } = require('../src/modules/direct/order-service.ts');
const { OperatorJournal } = require('../src/modules/direct/journal.ts');
module.exports = async function scheduling(source) {
  const originals = source.store.all((r) => Boolean(r.signedBytes)).slice(0, 3);
  assert.equal(originals.length, 3);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streak-order-scheduling-'));
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  function isolated(name) {
    return new OrderService({
      ...source.options,
      journal: new OperatorJournal(path.join(root, name), undefined, 1000),
      onObservation: undefined,
    });
  }
  function copy(row, signed = true) {
    const result = structuredClone(row);
    delete result.executionBytes;
    delete result.executionKind;
    delete result.executionHistory;
    delete result.conflictHash;
    result.state = signed ? 'accepted' : 'offered';
    if (!signed) {
      delete result.signedBytes;
      delete result.acceptedAt;
    }
    return result;
  }
  const deadline = async (promise) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Foreground payment blocked behind recovery RPC')),
            2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    const service = isolated('foreground');
    service.store.save(copy(originals[0]));
    service.store.save(copy(originals[1], false));
    service.store.save(copy(originals[2], false));
    const entered = deferred(),
      release = deferred();
    service.confirmed = async () => {
      entered.resolve();
      await release.promise;
      return false;
    };
    service.conflict = async () => undefined;
    service.broadcast = async () => {};
    service.input = async (point) => ({
      cell: ccc.Cell.from(
        originals[1].offer.inputs.find((c) => ccc.OutPoint.from(c.outPoint).eq(point)),
      ),
    });
    const recovery = service.recoverPending();
    await entered.promise;
    try {
      const accepted = await deadline(
        service.submit(
          originals[1].offer.id,
          originals[1].offer.ownerAddress,
          originals[1].signedBytes,
        ),
      );
      assert.equal(accepted.state, 'accepted');
      assert.equal(service.store.load(originals[1].offer.id).signedBytes, originals[1].signedBytes);
      const cancelled = await deadline(
        service.cancel(originals[2].offer.id, originals[2].offer.ownerAddress),
      );
      assert.equal(cancelled.state, 'cancelled');
    } finally {
      release.resolve();
      await recovery;
    }
    assert.equal(service.store.load(originals[2].offer.id).state, 'cancelled');

    const race = isolated('race');
    race.store.save(copy(originals[0]));
    const staleEntered = deferred(),
      staleRelease = deferred();
    const second = new OrderService(race.options);
    race.confirmed = async () => {
      staleEntered.resolve();
      await staleRelease.promise;
      throw Error('Delayed RPC failed');
    };
    second.confirmed = async () => false;
    second.conflict = async () => undefined;
    second.broadcast = async () => {};
    const stale = race.recoverPending();
    await staleEntered.promise;
    await second.recoverPending();
    const current = race.store.load(originals[0].offer.id);
    staleRelease.resolve();
    await stale;
    assert.deepEqual(
      race.store.load(originals[0].offer.id),
      current,
      'Stale failure must not overwrite newer recovery',
    );

    const lanes = isolated('lanes');
    lanes.store.save(copy(originals[0]));
    lanes.store.save(copy(originals[1]));
    const other = new OrderService(lanes.options);
    // Different recovery cursors start on different orders but compete for the same lane.
    other.cursor = 1;
    let count = 0;
    const prepared = deferred();
    const sharedLane = { txHash: `0x${'cd'.repeat(32)}`, index: 0 };
    const make = async (row) => {
      const tx = lanes.refund(row);
      tx.inputs.push(ccc.CellInput.from({ previousOutput: sharedLane }));
      count++;
      if (count === 2) prepared.resolve();
      await prepared.promise;
      return tx;
    };
    const broadcasts = [];
    for (const runner of [lanes, other]) {
      runner.confirmed = async () => true;
      runner.admit = make;
      runner.broadcast = async (bytes) => broadcasts.push(bytes);
    }
    await Promise.all([lanes.recoverPending(), other.recoverPending()]);
    const executions = lanes.store.all((r) => Boolean(r.executionBytes));
    assert.equal(executions.length, 1, 'Only one candidate can durably reserve the shared lane');
    assert(broadcasts.every((b) => b === executions[0].executionBytes));
    const expired = isolated('expiry');
    expired.store.save(copy(originals[0]));
    let clock = source.now();
    expired.now = () => clock;
    expired.confirmed = async () => true;
    expired.admit = async (row) => {
      clock = Number(row.offer.markets[0].cutoffMs) + 1;
      return expired.refund(row);
    };
    expired.broadcast = async () => {
      throw Error('Late admission must not broadcast');
    };
    await expired.recoverPending();
    assert.equal(
      expired.store.load(originals[0].offer.id).executionBytes,
      undefined,
      'Crossing expiry during preparation cannot persist admission',
    );

    const limit = isolated('limit');
    limit.store.save(copy(originals[0]));
    limit.confirmed = async () => true;
    let attempted = 0;
    limit.admit = async (row) => {
      for (let i = 0; i < 3; i++) {
        const active = copy(originals[1]);
        active.offer.id = require('node:crypto').randomUUID();
        active.state = 'refunding';
        active.executionKind = 'refund';
        active.executionBytes = limit.refund(active).toHex();
        limit.store.save(active);
      }
      return limit.refund(row);
    };
    limit.broadcast = async () => {
      attempted++;
    };
    await limit.recoverPending();
    assert.equal(
      limit.store.load(originals[0].offer.id).executionBytes,
      undefined,
      'Execution limit is rechecked at commit',
    );
    assert.equal(attempted, 0);
    console.log(
      'Order scheduling: delayed recovery permits signed acceptance/cancel; stale errors preserve newer state; competing lanes commit once.',
    );
  } finally {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert(path.basename(resolved).startsWith('streak-order-scheduling-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
};
