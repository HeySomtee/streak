/* Focused synthetic integration: real planner, signatures and recovery; no public RPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
require(path.join(root, 'node_modules/ts-node')).register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: {
    module: 'CommonJS',
    target: 'ES2022',
    moduleResolution: 'node',
    verbatimModuleSyntax: false,
  },
});
const ccc = require('@ckb-ccc/core');
const { OrderService } = require('../src/modules/direct/order-service.ts');
const { OrderMarkets } = require('../src/modules/direct/order-markets.ts');
const { OperatorJournal } = require('../src/modules/direct/journal.ts');
const { GenesisPlans, genesisReservedInputs } = require('../src/modules/direct/genesis-plans.ts');
const {
  operatorFundingBarrier,
  assertFreshOperatorInputs,
} = require('../src/modules/direct/cli.ts');
const { buildCreate } = require('../src/modules/direct/operator.ts');
const { commitMarketRollovers } = require('../src/modules/direct/market-rollover.ts');
const {
  DirectRegistry,
  createRecord,
  V5_DIRECT_CONFIG,
  V4_DIRECT_CONFIG,
} = require('../src/modules/direct/registry.ts');
async function main() {
  const { batchChain, attachBatchRpc } = await import('./batch-browser-fixture.mjs');
  const now = Date.now(),
    cutoff = now + 3600000;
  const chain = await batchChain(cutoff, []);
  global.fetch = async () => {
    throw Error('External network forbidden');
  };
  const client = attachBatchRpc(
    new ccc.ClientPublicTestnet({ url: 'http://127.0.0.1:1', fallbacks: [] }),
    chain.rpc,
  );
  client.findCellsPagedNoCache = async (search) => ({
    cells: [...chain.live.values()].filter((c) =>
      search.scriptType === 'type'
        ? c.cellOutput.type?.eq(search.script)
        : c.cellOutput.lock.eq(search.script),
    ),
    lastCursor: '0x',
  });
  const pending = new Map();
  client.sendTransactionNoCache = async (tx) => {
    pending.set(tx.hash(), tx.clone());
    return tx.hash();
  };
  const originalRead = client.getTransactionNoCache.bind(client);
  client.getTransactionNoCache = async (hash) =>
    pending.has(hash)
      ? ccc.ClientTransactionResponse.from({ transaction: pending.get(hash), status: 'pending' })
      : originalRead(hash);
  const mine = () => {
    for (const [hash, tx] of pending) {
      chain.commit(tx);
      pending.delete(hash);
    }
  };
  const sponsor = new ccc.SignerCkbPrivateKey(client, '0x' + '22'.repeat(32));
  const owners = ['11', '33'].map((v) => new ccc.SignerCkbPrivateKey(client, '0x' + v.repeat(32)));
  const locks = await Promise.all(
    owners.map(async (o) => (await o.getRecommendedAddressObj()).script),
  );
  chain.commit(
    ccc.Transaction.from({
      inputs: [],
      outputs: [{ capacity: 10000000000000n, lock: locks[1] }],
      outputsData: ['0x'],
    }),
  );
  const config = {
    ...V5_DIRECT_CONFIG,
    codeDeps: [0, 1].map((index) => ({
      outPoint: { txHash: '0x' + '44'.repeat(32), index },
      depType: 'code',
    })),
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'streak-demand-'));
  const fixtures = Array.from({ length: 8 }, (_, i) => ({
    id: `api-football-${920000 + i}`,
    sport: 'football',
    date: new Date(cutoff).toISOString().slice(0, 10),
    kickoff: new Date(cutoff).toISOString(),
    status: 'scheduled',
    stage: 'Synthetic',
    home: { id: '1', name: 'Home', code: 'H', flag: '' },
    away: { id: '2', name: 'Away', code: 'A', flag: '' },
    oracle: {
      provider: 'api-football',
      fixtureId: String(920000 + i),
      source: 'https://v3.football.api-sports.io',
    },
  }));
  try {
    const journal = new OperatorJournal(path.join(temp, 'operator'), undefined, 1000);
    const registry = new DirectRegistry(path.join(temp, 'registry'), config);
    const earlier = [new DirectRegistry(path.join(temp, 'legacy'), V4_DIRECT_CONFIG)];
    const options = {
      client,
      signer: sponsor,
      journal,
      registry,
      earlier,
      config,
      fixtures: async (ids) => ids.map((id) => fixtures.find((f) => f.id === id)),
      now: () => now,
    };
    const planner = new OrderMarkets(options);
    const [a, b] = await Promise.all([
      planner.prepare([fixtures[0].id], 'wallet-a'),
      planner.prepare([fixtures[0].id], 'wallet-a'),
    ]);
    assert.deepEqual(a, b);
    assert.equal(pending.size, 0);
    assert.equal(registry.all().length, 0);
    assert.equal(
      fs
        .readdirSync(journal.directory)
        .filter((f) => f.startsWith('create-') && f.endsWith('.json')).length,
      0,
    );
    let service = new OrderService({
      client,
      journal,
      registry,
      config,
      marketPreparation: planner,
      validateFixture: async () => {},
      now: () => now,
    });
    const offers = [];
    for (let i = 0; i < 2; i++) {
      const fund = [...chain.live.values()].find(
        (c) => c.cellOutput.lock.eq(locks[i]) && !c.cellOutput.type,
      );
      const offer = await service.prepare({
        requestId: randomUUID(),
        ownerAddress: await owners[i].getRecommendedAddress(),
        userInputs: [{ txHash: fund.outPoint.txHash, index: Number(fund.outPoint.index) }],
        picks: [
          {
            fixtureId: fixtures[0].id,
            termsHash: a[0].termsHash,
            outcome: i,
            principalShannons: '10000000000',
          },
        ],
      });
      const tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
      offer.inputs.forEach((c, j) => {
        tx.inputs[j].cellOutput = ccc.CellOutput.from(c.cellOutput);
        tx.inputs[j].outputData = c.outputData;
      });
      const signed = await owners[i].signTransaction(tx);
      assert.equal(
        (await service.submit(offer.id, offer.ownerAddress, signed.toHex())).state,
        'accepted',
      );
      offers.push(offer);
    }
    assert.equal(pending.size, 0, 'Both wallets sign before any transaction confirms');
    assert.equal(offers[0].markets[0].creationTxHash, offers[1].markets[0].creationTxHash);
    assert(
      !offers[0].inputs.some((a) =>
        offers[1].inputs.some((b) => ccc.OutPoint.from(a.outPoint).eq(b.outPoint)),
      ),
    );
    console.log(
      'PASS two wallets independently sign the same uncreated regular market; one durable genesis, no confirmation wait',
    );
    const multi = await planner.prepare(
      fixtures.slice(1, 4).map((f) => f.id),
      'wallet-a',
    );
    assert.equal(new Set(multi.map((m) => m.creationTxHash)).size, 1);
    assert.deepEqual(
      multi.map((m) => Buffer.from(m.type.args.slice(2), 'hex').readUInt32LE(32)),
      [0, 5, 10],
    );
    const third = await planner.prepare([fixtures[4].id], 'wallet-b');
    await assert.rejects(
      () => planner.prepare([fixtures[5].id], 'wallet-b'),
      /additional testnet capacity/,
    );
    assert.equal(pending.size, 0, 'Preview alone never broadcasts operator reserves');
    console.log(
      'PASS multi-match genesis uses one funding dependency; pending setup chain is bounded at three',
    );
    // Three pending unsigned ancestors must promote without treating the plain root
    // funding input as a fourth genesis. Actual acceptance/recovery is checked below.
    await planner.ensure(third);
    assert.equal(pending.size, 1);
    mine();
    // Reconstruct both service and planner, without either browser.
    const restarted = new OrderMarkets({
      ...options,
      journal: new OperatorJournal(journal.directory, undefined, 1000),
    });
    assert.deepEqual(await restarted.prepare([fixtures[0].id], 'wallet-a'), a);
    service = new OrderService({ ...service.options, marketPreparation: restarted });
    await service.recoverPending();
    assert.equal(
      pending.size,
      2,
      'Both independent owner funding transactions broadcast in one recovery pass',
    );
    mine();
    for (let i = 0; i < 8; i++) {
      await service.recoverPending();
      mine();
    }
    assert(offers.every((o) => service.status(o.id, o.ownerAddress).state === 'placed'));
    assert.equal(registry.all().length, 1);
    console.log(
      'PASS server restart completes genesis and both admissions without another signature',
    );
    // A later funded batch can progress exact signed parent change; all descriptors publish.
    for (let i = 0; i < 6; i++) {
      await restarted.ensure(third);
      mine();
    }
    assert.equal(registry.all().length, 5);
    const fresh = await restarted.prepare([fixtures[5].id], 'wallet-b');
    assert.equal(fresh.length, 1, 'Confirmed ancestry no longer consumes pending depth');
    console.log(
      'PASS exact genesis ancestry recovers and releases pending-chain capacity after confirmation',
    );
    // An explicit entry rollover preserves the funded old pool and lets its
    // fixture share a new signed payment with an ordinary uncreated fixture.
    const rolloverFixture = {
      ...fixtures[0],
      id: 'api-football-930001',
      oracle: { ...fixtures[0].oracle, fixtureId: '930001' },
    };
    const freshFixture = {
      ...fixtures[0],
      id: 'api-football-930002',
      oracle: { ...fixtures[0].oracle, fixtureId: '930002' },
    };
    const oldBuilt = await buildCreate(client, sponsor, rolloverFixture, now, config);
    for (const output of oldBuilt.tx.outputs.slice(0, 5)) {
      output.type.codeHash = V4_DIRECT_CONFIG.protocolHash;
      output.lock.args = output.type.hash();
    }
    chain.commit(oldBuilt.tx);
    const oldRecord = createRecord(
      rolloverFixture,
      {
        codeHash: V4_DIRECT_CONFIG.protocolHash,
        hashType: 'data2',
        args: oldBuilt.record.type.args,
      },
      oldBuilt.tx.hash(),
      V4_DIRECT_CONFIG,
    );
    const oldRegistry = new DirectRegistry(path.join(temp, 'rollover-old'), V4_DIRECT_CONFIG);
    oldRegistry.add(oldRecord);
    const oldOutputs = [...chain.live.values()].filter(
      (c) => c.outPoint.txHash === oldRecord.creationTxHash && c.cellOutput.type,
    );
    const rolloverJournal = new OperatorJournal(
      path.join(temp, 'rollover-journal'),
      undefined,
      1000,
    );
    const rolloverRegistry = new DirectRegistry(path.join(temp, 'rollover-new'), config);
    const rolloverFixtures = [rolloverFixture, freshFixture];
    const rolloverPlanner = new OrderMarkets({
      ...options,
      journal: rolloverJournal,
      registry: rolloverRegistry,
      earlier: [oldRegistry],
      fixtures: async (ids) => ids.map((id) => rolloverFixtures.find((f) => f.id === id)),
    });
    await assert.rejects(
      rolloverPlanner.prepare(
        rolloverFixtures.map((f) => f.id),
        'rollover-owner',
      ),
      /earlier payment flow/,
    );
    commitMarketRollovers(rolloverRegistry.directory, [rolloverFixture.id]);
    const mixed = await rolloverPlanner.prepare(
      rolloverFixtures.map((f) => f.id),
      'rollover-owner',
    );
    assert.equal(mixed.length, 2);
    assert(mixed.every((m) => m.type.codeHash === config.protocolHash));
    assert.notEqual(mixed[0].id, oldRecord.id);
    assert.deepEqual(rolloverPlanner.legacyFixtureIds(), []);
    const mixedService = new OrderService({
      client,
      journal: rolloverJournal,
      registry: rolloverRegistry,
      config,
      marketPreparation: rolloverPlanner,
      validateFixture: async () => {},
      now: () => now,
    });
    const mixedFund = [...chain.live.values()].find(
      (c) => c.cellOutput.lock.eq(locks[0]) && !c.cellOutput.type && c.outputData === '0x',
    );
    const mixedOffer = await mixedService.prepare({
      requestId: randomUUID(),
      ownerAddress: await owners[0].getRecommendedAddress(),
      userInputs: [{ txHash: mixedFund.outPoint.txHash, index: Number(mixedFund.outPoint.index) }],
      picks: mixed.map((m) => ({
        fixtureId: m.fixtureId,
        termsHash: m.termsHash,
        outcome: 0,
        principalShannons: '10000000000',
      })),
    });
    const mixedTx = ccc.Transaction.fromBytes(mixedOffer.unsignedBytes);
    mixedOffer.inputs.forEach((c, i) => {
      mixedTx.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
      mixedTx.inputs[i].outputData = c.outputData;
    });
    assert.equal(
      (
        await mixedService.submit(
          mixedOffer.id,
          mixedOffer.ownerAddress,
          (await owners[0].signTransaction(mixedTx)).toHex(),
        )
      ).state,
      'accepted',
    );
    for (let i = 0; i < 8; i++) {
      await mixedService.recoverPending();
      mine();
    }
    assert.equal(mixedService.status(mixedOffer.id, mixedOffer.ownerAddress).state, 'placed');
    assert.deepEqual(oldRegistry.get(rolloverFixture.id), oldRecord);
    assert(
      oldOutputs.every(
        (c) =>
          chain.live.get(`${c.outPoint.txHash}:${Number(c.outPoint.index)}`)?.cellOutput.toHex() ===
          c.cellOutput.toHex(),
      ),
      'fresh rollover never spends earlier market control or funds',
    );
    console.log(
      'PASS rolled-over and new fixtures share one signed payment and admission while old pool cells remain untouched',
    );

    const realNow = Date.now;
    let clock = now;
    Date.now = () => clock;
    try {
      const isolatedDir = path.join(temp, 'leases');
      const leaseJournal = new OperatorJournal(isolatedDir, undefined, 1000);
      const leaseRegistry = new DirectRegistry(path.join(temp, 'lease-registry'), config);
      const leasePlanner = new OrderMarkets({
        ...options,
        journal: leaseJournal,
        registry: leaseRegistry,
        now: () => clock,
      });
      const rootPlan = await leasePlanner.prepare([fixtures[6].id], 'preview-owner');
      assert.equal(
        (await operatorFundingBarrier(client, leaseJournal, leaseRegistry)).clear,
        true,
        'Unsigned preview cannot globally stop lifecycle work',
      );
      const rootInput = ccc.Transaction.fromBytes(
        new GenesisPlans(isolatedDir).all()[0].unsignedBytes,
      ).inputs[0].previousOutput;
      assert(genesisReservedInputs(isolatedDir, clock).has(rootInput.toHex()));
      clock += 60000;
      await leasePlanner.prepare([fixtures[7].id], 'preview-owner');
      clock += 270000;
      assert.equal(
        new GenesisPlans(isolatedDir).active(clock).length,
        2,
        'Live child retains expired unsigned parent',
      );
      clock += 31000;
      assert.equal(new GenesisPlans(isolatedDir).active(clock).length, 0);
      assert(!genesisReservedInputs(isolatedDir, clock).has(rootInput.toHex()));
      assertFreshOperatorInputs(
        leaseJournal,
        ccc.Transaction.from({ inputs: [{ previousOutput: rootInput }] }),
      );
      assert.throws(() => leasePlanner.assertAcceptable(rootPlan), /expired/);
      console.log(
        'PASS abandoned previews expire, live descendants retain ancestors, unrelated lifecycle barrier stays clear',
      );
      // A funded order past its on-chain expiry refunds without promoting genesis.
      clock = now;
      const refundPlanner = new OrderMarkets({
        ...options,
        journal: new OperatorJournal(path.join(temp, 'refund'), undefined, 1000),
        registry: new DirectRegistry(path.join(temp, 'refund-registry'), config),
        now: () => clock,
      });
      const descriptor = (await refundPlanner.prepare([fixtures[6].id], 'refund-owner'))[0];
      const refundService = new OrderService({
        client,
        journal: refundPlanner.options.journal,
        registry: refundPlanner.options.registry,
        config,
        now: () => clock,
        marketPreparation: refundPlanner,
        validateFixture: async () => {},
      });
      const free = [...chain.live.values()].find(
        (c) => c.cellOutput.lock.eq(locks[0]) && !c.cellOutput.type && c.outputData === '0x',
      );
      const offer = await refundService.prepare({
        requestId: randomUUID(),
        ownerAddress: await owners[0].getRecommendedAddress(),
        userInputs: [{ txHash: free.outPoint.txHash, index: Number(free.outPoint.index) }],
        picks: [
          {
            fixtureId: descriptor.fixtureId,
            termsHash: descriptor.termsHash,
            outcome: 0,
            principalShannons: '10000000000',
          },
        ],
      });
      const tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
      offer.inputs.forEach((c, i) => {
        tx.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
        tx.inputs[i].outputData = c.outputData;
      });
      await refundService.submit(
        offer.id,
        offer.ownerAddress,
        (await owners[0].signTransaction(tx)).toHex(),
      );
      await refundService.recoverPending();
      mine();
      clock = cutoff + 1;
      refundPlanner.ensure = async () => {
        throw Error('Expired order must never require market setup');
      };
      await refundService.recoverPending();
      mine();
      await refundService.recoverPending();
      assert.equal(refundService.status(offer.id, offer.ownerAddress).state, 'refunded');
      assert.equal(
        new GenesisPlans(refundPlanner.options.journal.directory).active(clock).length,
        0,
        'Expired accepted order cannot pin an unsigned setup forever',
      );
      console.log(
        'PASS funded expired order refunds without genesis, and terminal unsigned setup releases its reservation',
      );
    } finally {
      Date.now = realNow;
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
