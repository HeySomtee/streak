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
  const journal = new OperatorJournal(path.join(directory, 'operator')),
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
  const creation = await buildCreate(client, h.admin.signer, fixture, h.getClock(), config),
    signed = await h.admin.signer.signTransaction(creation.tx);
  await h.commit(h.admin, signed);
  await h.mine(4);
  await registry.publishCanonical(creation.record, client);
  const options = {
    client,
    journal,
    registry,
    config,
    now: h.getClock,
    validateFixture: async () => {},
  };
  let service = new OrderService(options);
  const owner = await h.owner.signer.getRecommendedAddress();
  const input = {
    txHash: h.owner.fund.outPoint.txHash,
    index: Number(h.owner.fund.outPoint.index),
  };
  const request = (p) => ({
    requestId: randomUUID(),
    ownerAddress: owner,
    userInputs: [p],
    picks: [
      {
        fixtureId: fixture.id,
        termsHash: creation.record.termsHash,
        outcome: 0,
        principalShannons: '10000000000',
      },
    ],
  });
  const offers = [];
  let next = input;
  for (let i = 0; i < 3; i++) {
    const offer = await service.prepare(request(next));
    validateOrderOffer(offer);
    const tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
    offer.inputs.forEach((cell, j) => {
      tx.inputs[j].cellOutput = ccc.CellOutput.from(cell.cellOutput);
      tx.inputs[j].outputData = cell.outputData;
    });
    const authorized = await h.owner.signer.signTransaction(tx);
    const status = await service.submit(offer.id, owner, authorized.toHex());
    assert.equal(status.state, 'accepted');
    assert.equal(
      (await service.submit(offer.id, owner, authorized.toHex())).fundingHash,
      offer.rawHash,
    );
    offers.push(offer);
    next = { txHash: offer.rawHash, index: 1 };
  }
  await assert.rejects(() => service.prepare(request(next)), /Three payments/);
  assert.equal((await service.wallet(owner)).orders.length, 3);
  h.record('Same wallet approved three slips before any funding confirmation');
  service = new OrderService(options); // Browser and original operator instance are gone.
  for (let i = 0; i < 32; i++) {
    await service.recoverPending();
    await h.mine(4);
    if (offers.every((o) => service.status(o.id, owner).state === 'placed')) break;
  }
  for (const offer of offers) {
    const status = service.status(offer.id, owner);
    assert.equal(
      status.state,
      'placed',
      JSON.stringify({ state: status.state, internal: service.store.load(offer.id).message }),
    );
    const execution = await client.getTransactionNoCache(status.executionHash);
    assert.equal(execution.status, 'committed');
    assert(execution.transaction.outputs.at(-1).lock.eq(h.owner.lock));
  }
  h.record('Restarted operator funded and placed all three authorized slips without browser calls');
  const markets = [creation.record];
  for (let i = 1; i < 8; i++) {
    const fixtureId = String(990001 + i),
      extra = {
        ...fixture,
        id: `api-football-${fixtureId}`,
        oracle: { ...fixture.oracle, fixtureId },
      };
    const created = await buildCreate(client, h.admin.signer, extra, h.getClock(), config);
    await h.commit(h.admin, await h.admin.signer.signTransaction(created.tx));
    await h.mine(4);
    await registry.publishCanonical(created.record, client);
    markets.push(created.record);
  }
  const bundle = await service.prepare({
    ...request(next),
    picks: markets.map((m) => ({
      fixtureId: m.fixtureId,
      termsHash: m.termsHash,
      outcome: 0,
      principalShannons: '10000000000',
    })),
  });
  const bundleTx = ccc.Transaction.fromBytes(bundle.unsignedBytes);
  bundle.inputs.forEach((c, i) => {
    bundleTx.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
    bundleTx.inputs[i].outputData = c.outputData;
  });
  await service.submit(bundle.id, owner, (await h.owner.signer.signTransaction(bundleTx)).toHex());
  for (let i = 0; i < 16; i++) {
    await service.recoverPending();
    await h.mine(4);
    if (service.status(bundle.id, owner).state === 'placed') break;
  }
  assert.equal(service.status(bundle.id, owner).state, 'placed');
  const bundleExecution = (
    await client.getTransactionNoCache(service.status(bundle.id, owner).executionHash)
  ).transaction;
  assert.equal(bundleExecution.outputs.length, 9);
  assert.equal(bundleExecution.inputs.length, 9);
  h.record('Eight-market signed slip admits atomically with exact owner reserve return');
  const stale = await service.prepare(request({ txHash: bundle.rawHash, index: 1 }));
  const staleFunding = ccc.Transaction.fromBytes(stale.unsignedBytes);
  stale.inputs.forEach((c, i) => {
    staleFunding.inputs[i].cellOutput = ccc.CellOutput.from(c.cellOutput);
    staleFunding.inputs[i].outputData = c.outputData;
  });
  await service.submit(
    stale.id,
    owner,
    (await h.owner.signer.signTransaction(staleFunding)).toHex(),
  );
  // Persist an admission before broadcasting, then let the result report spend
  // its control dependency. The order and lane inputs themselves stay live.
  await h.commit(h.owner, ccc.Transaction.fromBytes(service.store.load(stale.id).signedBytes));
  await h.mine(4);
  const staleRow = service.store.load(stale.id),
    staleExecution = await service.admit(staleRow, new Set());
  assert(staleExecution);
  staleRow.executionBytes = staleExecution.toHex();
  staleRow.executionKind = 'admit';
  staleRow.state = 'placing';
  service.store.save(staleRow);
  const evm = await setupOmniActor(h, client);
  const evmOptions = { ...options, client: evm.signer.client };
  const evmService = new OrderService(evmOptions),
    evmAddress = await evm.signer.getRecommendedAddress();
  const evmOffer = await evmService.prepare({
    ...request({ txHash: evm.fund.outPoint.txHash, index: Number(evm.fund.outPoint.index) }),
    ownerAddress: evmAddress,
  });
  const evmTx = ccc.Transaction.fromBytes(evmOffer.unsignedBytes);
  evmOffer.inputs.forEach((cell, i) => {
    evmTx.inputs[i].cellOutput = ccc.CellOutput.from(cell.cellOutput);
    evmTx.inputs[i].outputData = cell.outputData;
  });
  const evmSigned = await evm.signer.signTransaction(evmTx);
  assert.equal(
    (await evmService.submit(evmOffer.id, evmAddress, evmSigned.toHex())).state,
    'accepted',
  );
  await assert.rejects(
    () => evmService.submit(evmOffer.id, owner, evmSigned.toHex()),
    /another wallet/,
  );
  h.setClock(cutoff + 1000);
  await h.mine(20);
  const payload = {
    errors: [],
    response: [
      {
        fixture: {
          id: Number(creation.record.terms.providerFixtureId),
          date: new Date(cutoff).toISOString(),
          timestamp: cutoff / 1000,
          status: { short: 'FT' },
        },
        score: { fulltime: { home: 2, away: 1 } },
      },
    ],
  };
  h.setClock(cutoff + 31000);
  await h.mine(4);
  const result = confirmFootballEvidence(
    validateFootballEvidence(creation.record, payload, h.getClock() - 30000),
    validateFootballEvidence(creation.record, payload, h.getClock()),
    h.getClock(),
  );
  await h.commit(
    h.admin,
    await h.admin.signer.signTransaction(
      await buildReport(client, h.admin.signer, creation.record, result, h.getClock(), config),
    ),
  );
  await h.mine(4);
  for (let i = 0; i < 20; i++) {
    await evmService.recoverPending();
    await h.mine(4);
    if (evmService.status(evmOffer.id, evmAddress).state === 'refunded') break;
  }
  const refund = evmService.status(evmOffer.id, evmAddress);
  assert.equal(refund.state, 'refunded');
  const refundTx = (await evm.signer.client.getTransactionNoCache(refund.executionHash))
    .transaction;
  assert(refundTx.outputs[0].lock.eq(evm.lock));
  assert(BigInt(evmOffer.capacityShannons) - refundTx.outputs[0].capacity <= 100000000n);
  assert.equal(evm.signer.messages.length, 1, 'Refund must not ask the EVM wallet to sign again');
  h.record('EVM personal-sign order refunded automatically after expiry with one wallet approval');
  for (let i = 0; i < 20; i++) {
    await service.recoverPending();
    await h.mine(4);
    if (service.status(stale.id, owner).state === 'refunded') break;
  }
  assert.equal(service.status(stale.id, owner).state, 'refunded');
  assert.equal(service.store.load(stale.id).executionHistory.length, 1);
  h.record(
    'Canonical control-dependency spend retires an unbroadcast admission and refunds without another signature',
  );
  await h.commit(
    h.admin,
    await h.admin.signer.signTransaction(
      await buildClose(client, h.admin.signer, creation.record, 'settle', h.getClock(), config),
    ),
  );
  await h.mine(4);
  const { createDevnetDirectClient } = await import('../web/src/features/direct/client.ts');
  const { configureOrderManifest, protocolManifest, parseDescriptor } =
    await import('../web/src/features/direct/protocol.ts');
  configureOrderManifest({ ...config, enabled: true });
  const saved = new Map(),
    walletJournal = {
      list: async (scope) => [...saved.values()].filter((r) => r.scope === scope),
      put: async (row) => {
        saved.set(row.hash, row);
      },
    };
  const adapter = await createDevnetDirectClient(
    h.owner.signer,
    config.codeDeps,
    'v5-order-owner',
    walletJournal,
    { now: h.getClock, exclusive: async (_name, fn) => fn() },
    protocolManifest(config.protocolHash),
  );
  const descriptor = await parseDescriptor({ ...creation.record, entryEnabled: false });
  const positions = (await adapter.discover(descriptor)).positions.filter(
    (p) => p.status === 'claimable',
  );
  assert.equal(positions.length, 4);
  const claim = await adapter.signAndPersist(
    await adapter.prepareClaim(descriptor, positions[0].outPoint),
    descriptor,
  );
  await adapter.broadcast(claim);
  await h.commit(h.owner, ccc.Transaction.fromBytes(claim.signedBytes), true);
  await h.mine(4);
  assert.equal((await adapter.recover(claim)).status, 'confirmed');
  await assert.rejects(
    () => adapter.prepareClaim(descriptor, positions[0].outPoint),
    /spent|unavailable/,
  );
  h.record('Queued entries settle and use the existing wallet claim flow with replay rejection');
  const {
    prepareOrderDeployment,
    reconcileOrderDeployment,
  } = require('../src/modules/direct/order-deployment.ts');
  const {
    loadOperatorDeployment,
    operatorFundingBarrier,
    assertFreshOperatorInputs,
  } = require('../src/modules/direct/cli.ts');
  const deployJournal = new OperatorJournal(path.join(directory, 'deployment'));
  const deployRegistry = new DirectRegistry(path.join(directory, 'deployment-registry'), config);
  const binary = ccc.bytesFrom(protocol.outputData);
  await assert.rejects(
    () =>
      prepareOrderDeployment(
        client,
        h.admin.signer,
        deployJournal,
        deployRegistry,
        new Uint8Array([0]),
      ),
    /pinned/,
  );
  const deploymentRow = await prepareOrderDeployment(
    client,
    h.admin.signer,
    deployJournal,
    deployRegistry,
    binary,
  );
  const deploymentTx = ccc.Transaction.fromBytes(deploymentRow.signedTransaction);
  assert.equal(ccc.hashCkb(deploymentTx.outputsData[0]), config.protocolHash);
  assert.deepEqual(
    await prepareOrderDeployment(
      client,
      h.admin.signer,
      new OperatorJournal(deployJournal.directory),
      deployRegistry,
      binary,
    ),
    deploymentRow,
  );
  assert.equal((await operatorFundingBarrier(client, deployJournal, deployRegistry)).clear, false);
  assert.throws(
    () => assertFreshOperatorInputs(deployJournal, deploymentTx),
    /immutable deployment/,
  );
  assert.equal(
    (await reconcileOrderDeployment(client, deployJournal)).status,
    'ready-to-rebroadcast',
  );
  const send = client.sendTransactionNoCache.bind(client);
  client.sendTransactionNoCache = async (...args) => {
    await send(...args);
    throw Error('Synthetic lost deployment response');
  };
  try {
    await assert.rejects(
      () => reconcileOrderDeployment(client, deployJournal, true),
      /lost deployment response/,
    );
  } finally {
    client.sendTransactionNoCache = send;
  }
  assert.deepEqual(
    loadOperatorDeployment(new OperatorJournal(deployJournal.directory), 'v5'),
    deploymentRow,
  );
  await h.commit(h.admin, deploymentTx, true);
  await h.mine(4);
  assert.equal((await reconcileOrderDeployment(client, deployJournal, true)).status, 'committed');
  assert.equal((await operatorFundingBarrier(client, deployJournal, deployRegistry)).clear, true);
  h.record(
    'V5 deployment persists exact signed bytes, protects inputs and recovers a lost broadcast response after restart',
  );
  await h.finish();
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
