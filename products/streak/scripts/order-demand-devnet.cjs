/* Actual signatures and recovery on an owned disposable node. No hosted secrets. */
const assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  { randomUUID } = require('node:crypto');
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
const { boot } = require('./batch-devnet-harness.cjs');
const { OrderService } = require('../src/modules/direct/order-service.ts');
const { DirectRegistry, V5_DIRECT_CONFIG } = require('../src/modules/direct/registry.ts');
const { OperatorJournal } = require('../src/modules/direct/journal.ts');
const { buildCreate, buildReport, buildClose } = require('../src/modules/direct/operator.ts');
const {
  validateFootballEvidence,
  confirmFootballEvidence,
} = require('../src/modules/direct/oracle.ts');
const { validateOrderOffer } = require('../shared/order-codec.mjs');
const { setupOmniActor } = require('./direct-omnilock.cjs');
async function main() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.STREAK_SKIP_ENV_FILE, '1');
  const h = await boot('v5'),
    client = h.admin.signer.client;
  await h.mine(4);
  const deployment = (
    await client.findCellsPagedNoCache(
      { script: h.admin.lock, scriptType: 'lock', scriptSearchMode: 'exact', withData: true },
      'asc',
      64,
    )
  ).cells;
  const protocol = deployment.find(
      (c) => ccc.hashCkb(c.outputData) === V5_DIRECT_CONFIG.protocolHash,
    ),
    guard = deployment.find((c) => ccc.hashCkb(c.outputData) === V5_DIRECT_CONFIG.guardHash);
  assert(protocol && guard, 'Pinned v5 code must be deployed');
  const config = {
    ...V5_DIRECT_CONFIG,
    codeDeps: [protocol, guard].map((c) => ({
      outPoint: { txHash: c.outPoint.txHash, index: Number(c.outPoint.index) },
      depType: 'code',
    })),
  };
  const directory = fs.mkdtempSync(path.join(root, '.quality-artifacts/order-devnet-'));
  const journal = new OperatorJournal(path.join(directory, 'operator'), undefined, 10000),
    registry = new DirectRegistry(path.join(directory, 'registry'), config);
  const cutoff = h.getClock() + 600000;
  const fixture = {
    id: 'api-football-990001',
    sport: 'football',
    date: new Date(cutoff).toISOString().slice(0, 10),
    kickoff: new Date(cutoff).toISOString(),
    status: 'scheduled',
    stage: 'Synthetic order testing',
    home: { id: '1', name: 'Home', code: 'HOM', flag: '' },
    away: { id: '2', name: 'Away', code: 'AWY', flag: '' },
    oracle: {
      provider: 'api-football',
      fixtureId: '990001',
      source: 'https://v3.football.api-sports.io',
    },
  };
  const { OrderMarkets } = require('../src/modules/direct/order-markets.ts');
  const realNow = Date.now;
  Date.now = h.getClock;
  const fixtures = [
    fixture,
    ...[2, 3].map((i) => ({
      ...fixture,
      id: 'api-football-' + (990000 + i),
      oracle: { ...fixture.oracle, fixtureId: String(990000 + i) },
    })),
  ];
  const second = new ccc.SignerCkbPrivateKey(client, '0x' + '33'.repeat(32)),
    secondLock = (await second.getRecommendedAddressObj()).script;
  const topup = await h.build(
    h.admin,
    [],
    [{ capacity: 10000n * h.CKB, lock: secondLock }],
    ['0x'],
  );
  const cells = await h.commit(h.admin, topup);
  await h.mine(4);
  const planner = new OrderMarkets({
    client,
    signer: h.admin.signer,
    journal,
    registry,
    earlier: [],
    config,
    now: h.getClock,
    fixtures: async (ids) => ids.map((id) => fixtures.find((f) => f.id === id)),
  });
  const both = await Promise.all([
    planner.prepare(
      fixtures.map((f) => f.id),
      'one',
    ),
    planner.prepare([fixture.id], 'two'),
  ]);
  assert.equal(both[0][0].creationTxHash, both[1][0].creationTxHash);
  assert.equal(registry.all().length, 0);
  const opts = {
    client,
    journal,
    registry,
    config,
    now: h.getClock,
    validateFixture: async () => {},
    marketPreparation: planner,
  };
  let service = new OrderService(opts);
  const offers = [];
  for (const [index, actor] of [h.owner.signer, second].entries()) {
    const fund = index === 0 ? h.owner.fund : cells[0];
    const markets = index === 0 ? both[0] : both[1];
    const offer = await service.prepare({
      requestId: randomUUID(),
      ownerAddress: await actor.getRecommendedAddress(),
      userInputs: [{ txHash: fund.outPoint.txHash, index: Number(fund.outPoint.index) }],
      picks: markets.map((m) => ({
        fixtureId: m.fixtureId,
        termsHash: m.termsHash,
        outcome: index,
        principalShannons: '10000000000',
      })),
    });
    const tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
    offer.inputs.forEach((c, i) => {
      tx.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
      tx.inputs[i].outputData = c.outputData;
    });
    const signed = await actor.signTransaction(tx);
    assert.equal(
      (await service.submit(offer.id, offer.ownerAddress, signed.toHex())).state,
      'accepted',
    );
    offers.push(offer);
  }
  assert.equal(await client.getTransactionNoCache(both[0][0].creationTxHash), undefined);
  h.record(
    'Two wallets sign independent orders for one uncreated regular market before genesis or payment confirmation',
  );
  service = new OrderService({ ...opts, journal: new OperatorJournal(journal.directory) });
  for (let i = 0; i < 16; i++) {
    await service.recoverPending();
    await new Promise((r) => setTimeout(r, 150));
    await h.mine(5);
    if (offers.every((o) => service.status(o.id, o.ownerAddress).state === 'placed')) break;
  }
  assert.deepEqual(
    offers.map((o) => service.status(o.id, o.ownerAddress).state),
    ['placed', 'placed'],
  );
  assert.equal(registry.all().length, 3);
  h.record(
    'Native v5 scripts accept one three-market genesis and both queued admissions after server restart',
  );
  for (const offer of offers) {
    const row = service.store.load(offer.id),
      tx = ccc.Transaction.fromBytes(row.executionBytes);
    assert.equal((await client.getTransactionNoCache(tx.hash())).status, 'committed');
  }
  Date.now = realNow;
  await h.finish();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
