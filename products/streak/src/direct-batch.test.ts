import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as ccc from '@ckb-ccc/core';
import { BatchService, parseBatchRequest } from './modules/direct/batch';
import { createSponsorServer } from './modules/direct/sponsor-http';
import type { AddressInfo } from 'node:net';
import { verifySponsorOwnerWitness, type SponsorOffer } from './modules/direct/sponsor';
import {
  cancelUnsignedSponsorOffers,
  sponsorFundingBlocked,
} from './modules/direct/sponsor-journal';
import { OperatorJournal, operationKey } from './modules/direct/journal';
import {
  DirectRegistry,
  V4_DIRECT_CONFIG,
  PUBLIC_DIRECT_CONFIG,
  PROVIDER_ORIGIN,
  createRecord,
} from './modules/direct/registry';
import { operatorFundingBarrier } from './modules/direct/cli';
import { ReviewWaitingError } from './modules/direct/review-queue';
import { loadOperatorMarket } from './modules/direct/operator';
import type { Match } from './types';
import type { BatchPick } from '../shared/batch-wire';

const CKB = 100_000_000n,
  NOW = 1_800_000_000_000,
  H = (digit: string) => `0x${digit.repeat(64)}`;
function header(hash: string, number: number) {
  return ccc.ClientBlockHeader.from({
    compactTarget: 0,
    dao: { c: 0, ar: 0, s: 0, u: 0 },
    epoch: [0, 0, 1],
    extraHash: H('0'),
    hash,
    nonce: 0,
    number,
    parentHash: H('0'),
    proposalsHash: H('0'),
    timestamp: NOW,
    transactionsRoot: H('0'),
    version: 0,
  });
}
async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'streak-batch-'));
  try {
    const client = new ccc.ClientPublicTestnet({ url: 'http://127.0.0.1:1', fallbacks: [] });
    const sponsor = new ccc.SignerCkbPrivateKey(client, `0x${'01'.repeat(32)}`),
      owner = new ccc.SignerCkbPrivateKey(client, `0x${'02'.repeat(32)}`);
    const sponsorLock = (await sponsor.getRecommendedAddressObj()).script,
      ownerLock = (await owner.getRecommendedAddressObj()).script,
      ownerAddress = await owner.getRecommendedAddress();
    const fundingTx = ccc.Transaction.from({
      inputs: [{ previousOutput: { txHash: H('1'), index: 0 } }],
      outputs: [{ capacity: 30_000n * CKB, lock: sponsorLock }],
      outputsData: ['0x'],
    });
    const fund = ccc.Cell.from({
        outPoint: { txHash: fundingTx.hash(), index: 0 },
        cellOutput: { capacity: 30_000n * CKB, lock: sponsorLock },
        outputData: '0x',
      }),
      user = ccc.Cell.from({
        outPoint: { txHash: H('2'), index: 0 },
        cellOutput: { capacity: 10_000n * CKB, lock: ownerLock },
        outputData: '0x',
      });
    const cells = new Map([fund, user].map((cell) => [cell.outPoint.toHex(), cell])),
      history = new Map<string, ccc.ClientTransactionResponse>();
    history.set(
      fundingTx.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: fundingTx,
        status: 'committed',
        blockHash: H('6'),
        blockNumber: 10,
      }),
    );
    client.getCellLiveNoCache = async (point) => cells.get(ccc.OutPoint.from(point).toHex());
    client.getCell = async (point) => cells.get(ccc.OutPoint.from(point).toHex());
    client.findCellsPagedNoCache = async (key) => ({
      cells: [...cells.values()].filter((cell) =>
        key.scriptType === 'type'
          ? cell.cellOutput.type?.eq(key.script)
          : cell.cellOutput.lock.eq(key.script) && !cell.cellOutput.type,
      ),
      lastCursor: '0x',
    });
    client.getTransactionNoCache = async (hash) => history.get(ccc.hexFrom(hash));
    client.getHeaderByNumberNoCache = async () => header(H('6'), 10);
    client.getTipHeader = async () => header(H('7'), 13);
    let broadcasts = 0;
    client.sendTransactionNoCache = async () => {
      broadcasts++;
      throw Error('Isolated delivery interrupted');
    };
    const config = { ...V4_DIRECT_CONFIG, codeDeps: PUBLIC_DIRECT_CONFIG.codeDeps },
      journal = new OperatorJournal(join(directory, 'operator'), config),
      registry = new DirectRegistry(join(directory, 'registry'), config);
    let now = NOW;
    const fixture = (id: string): Match => ({
      id,
      sport: 'football',
      date: '2027-01-15',
      kickoff: new Date(NOW + 3_600_000).toISOString(),
      status: 'scheduled',
      stage: 'Synthetic isolated atomic test',
      home: { id: '1', name: `Synthetic ${id}`, code: 'H', flag: '' },
      away: { id: '2', name: 'Synthetic Away', code: 'A', flag: '' },
      oracle: { provider: 'api-football', fixtureId: id.slice(13), source: PROVIDER_ORIGIN },
    });
    let fixtureReads = 0,
      maxFixtureReads = 0;
    const options = {
      client,
      signer: sponsor,
      journal,
      registry,
      config,
      fixture: async (id: string) => {
        fixtureReads++;
        maxFixtureReads = Math.max(maxFixtureReads, fixtureReads);
        try {
          await new Promise((done) => setTimeout(done, 5 - (Number(id.slice(13)) % 4)));
          return fixture(id);
        } finally {
          fixtureReads--;
        }
      },
      now: () => now,
    };
    const service = new BatchService(options),
      picks: BatchPick[] = [];
    for (let i = 1; i <= 8; i++) {
      const demand = await service.describe(`api-football-${9000 + i}`);
      picks.push({
        fixtureId: demand.fixtureId,
        termsHash: demand.termsHash,
        outcome: (i % 3) as 0 | 1 | 2,
        principalShannons: (100n * CKB).toString(),
      });
    }
    const request = {
      requestId: randomUUID(),
      ownerAddress,
      userInputs: [{ txHash: user.outPoint.txHash, index: 0 }],
      picks,
    };
    assert.throws(
      () => parseBatchRequest({ ...request, picks: [...picks, picks[0]] }),
      /one to eight/,
    );
    assert.throws(() => parseBatchRequest({ ...request, picks: [picks[0], picks[0]] }), /repeat/);
    class SlowInitialValidation extends BatchService {
      protected override async validateFrozen(value: SponsorOffer): Promise<void> {
        await super.validateFrozen(value);
        now += 100_000;
      }
    }
    const slowReview = new SlowInitialValidation({
      ...options,
      journal: new OperatorJournal(join(directory, 'slow-review-operator'), config),
      registry: new DirectRegistry(join(directory, 'slow-review-registry'), config),
    });
    const slowRequest = { ...request, requestId: randomUUID() };
    const slowOffer = await slowReview.prepareOffer(slowRequest);
    assert.equal(
      slowOffer.expiresAt - now,
      300_000,
      'RPC validation does not consume the user signing window',
    );
    now += 95_000;
    assert.deepEqual(
      await slowReview.prepareOffer(slowRequest),
      slowOffer,
      'retry does not extend an existing lease',
    );
    const slowSignature = await owner.signOnlyTransaction(
      ccc.Transaction.fromBytes(slowOffer.unsignedBytes),
    );
    const slowReceipt = await slowReview.submit(
      {
        offerId: slowOffer.offerId,
        rawHash: slowOffer.rawHash,
        userSignedBytes: slowSignature.toHex(),
      },
      true,
    );
    assert.equal(
      slowReceipt.ownerSignatureAccepted,
      true,
      'timely slow approval survives subsequent validation',
    );
    assert.equal(broadcasts, 0, 'durable acknowledgement precedes network submission');
    now = NOW;
    console.log(
      'PASS full bounded signing window starts after validation, preserves idempotency and accepts delayed approval',
    );

    const offer = await service.prepareOffer(request),
      tx = ccc.Transaction.fromBytes(offer.unsignedBytes);
    assert.equal(maxFixtureReads, 4, 'independent provider reads run with at most four in flight');
    assert.equal(fixtureReads, 0);
    assert.deepEqual(
      offer.lines.map((line) => line.fixture.fixtureId),
      picks.map((pick) => pick.fixtureId),
    );
    assert.equal(tx.outputs.length, 42);
    assert.equal(offer.reserveShannons, (24_400n * CKB).toString());
    assert.equal(offer.storageShannons, (2568n * CKB).toString());
    assert.equal(fund.cellOutput.capacity - tx.outputs[40].capacity, 24_400n * CKB);
    assert.equal(
      user.cellOutput.capacity - tx.outputs[41].capacity,
      3368n * CKB + BigInt(offer.feeShannons),
    );
    for (const [i, line] of offer.lines.entries()) {
      assert.equal(line.outputIndex, i * 5);
      assert.equal(Buffer.from(line.descriptor.type.args.slice(2), 'hex').readUInt32LE(32), i * 5);
      assert.equal(
        line.descriptor.type.args.slice(2, 66),
        ccc.hashCkb(fund.outPoint.toBytes()).slice(2),
      );
      assert.equal(line.descriptor.creationTxHash, offer.rawHash);
    }
    assert.equal(
      new Set(offer.lines.map((line) => ccc.Script.from(line.descriptor.type).hash())).size,
      8,
    );
    assert.deepEqual(await service.prepareOffer(request), offer);
    assert.equal(sponsorFundingBlocked(journal.directory, NOW), true);
    const waiting = await Promise.all(
      ['03', '04', '05'].map(async (key) => ({
        ...request,
        requestId: randomUUID(),
        ownerAddress: await new ccc.SignerCkbPrivateKey(
          client,
          `0x${key.repeat(32)}`,
        ).getRecommendedAddress(),
      })),
    );
    for (const queued of waiting)
      await assert.rejects(
        service.prepareOffer(queued),
        (error) => error instanceof ReviewWaitingError && error.position === 0,
      );
    await service.cancelReview(waiting[0].requestId, waiting[1].ownerAddress);
    await assert.rejects(
      service.prepareOffer(waiting[1]),
      (error) => error instanceof ReviewWaitingError && error.position === 0,
    );
    await service.cancelReview(waiting[0].requestId, waiting[0].ownerAddress);
    await assert.rejects(
      service.prepareOffer(waiting[1]),
      (error) => error instanceof ReviewWaitingError && error.position === 0,
    );
    for (const queued of waiting) await service.cancelReview(queued.requestId, queued.ownerAddress);
    assert.equal(
      service.store.load(offer.offerId)?.state,
      'offered',
      'queue cancellation cannot alter another owner offer',
    );
    assert.equal(broadcasts, 0, 'queue never signs or broadcasts');
    console.log(
      'PASS local input waits yield queue priority and preserve owner-scoped cancellation',
    );
    assert.equal(cancelUnsignedSponsorOffers(journal.directory), 1);
    assert.equal(
      (await service.status({ offerId: offer.offerId, rawHash: offer.rawHash }))
        .unsignedCancellation,
      true,
    );
    assert.equal(sponsorFundingBlocked(journal.directory, NOW), false);
    await assert.rejects(
      () =>
        service.submit({
          offerId: offer.offerId,
          rawHash: offer.rawHash,
          userSignedBytes: offer.unsignedBytes,
        }),
      /invalidated/,
    );
    console.log(
      'PASS atomic eight-pick bounds, unique origins, exact totals and lifecycle preemption',
    );

    let completedFixtureReads = 0;
    const failing = new BatchService({
      ...options,
      registry: new DirectRegistry(join(directory, 'failed-fixture-registry'), config),
      journal: new OperatorJournal(join(directory, 'failed-fixture-operator'), config),
      fixture: async (id: string) => {
        try {
          if (id === picks[0].fixtureId) throw Error('Isolated fixture failure');
          await new Promise((done) => setTimeout(done, 5));
          return fixture(id);
        } finally {
          completedFixtureReads++;
        }
      },
    });
    await assert.rejects(
      () => failing.prepareOffer({ ...request, requestId: randomUUID() }),
      /Isolated fixture failure/,
    );
    assert.equal(
      completedFixtureReads,
      4,
      'all started reads settle before the operator lease releases',
    );
    assert.equal(failing.store.all().length, 0, 'a failed provider group cannot persist an offer');
    assert.equal(broadcasts, 0);
    console.log('PASS bounded fixture reads preserve order and drain failures before mutation');

    let validationBoundary = false,
      boundaryExpiry = 0;
    const rejectionService = new BatchService({
      ...options,
      registry: new DirectRegistry(join(directory, 'rejection-registry'), config),
      journal: new OperatorJournal(join(directory, 'rejection-operator'), config),
      fixture: async (id) => {
        const match = await fixture(id);
        if (validationBoundary) now = boundaryExpiry;
        return match;
      },
    });
    const rejectedOffer = await rejectionService.prepareOffer({
      ...request,
      requestId: randomUUID(),
    });
    boundaryExpiry = rejectedOffer.expiresAt;
    const rejectedPartial = await owner.signOnlyTransaction(
      ccc.Transaction.fromBytes(rejectedOffer.unsignedBytes),
    );
    validationBoundary = true;
    await assert.rejects(
      rejectionService.submit(
        {
          offerId: rejectedOffer.offerId,
          rawHash: rejectedOffer.rawHash,
          userSignedBytes: rejectedPartial.toHex(),
        },
        true,
      ),
      /offer expired/,
    );
    assert.equal(
      rejectionService.store.load(rejectedOffer.offerId)?.userSignedBytes,
      undefined,
      'expiry during validation does not accept a late signature',
    );
    const alias = structuredClone(rejectionService.store.load(rejectedOffer.offerId)!);
    alias.offer.offerId = randomUUID();
    alias.requestId = randomUUID();
    rejectionService.store.save(alias);
    const refusal = await rejectionService.rejectUnsigned({
      offerId: rejectedOffer.offerId,
      rawHash: rejectedOffer.rawHash,
    });
    assert.equal(refusal.unsignedRejection, true);
    assert.equal(refusal.unsignedCancellation, true);
    assert.equal(
      rejectionService.store.load(alias.offer.offerId)?.state,
      'cancelled',
      'all unsigned aliases are permanently cancelled together',
    );
    await assert.rejects(
      rejectionService.submit(
        {
          offerId: alias.offer.offerId,
          rawHash: alias.offer.rawHash,
          userSignedBytes: rejectedPartial.toHex(),
        },
        true,
      ),
      /invalidated/,
    );
    now = NOW;
    console.log(
      'PASS validation-time expiry is rejected and all unsigned duplicate identities cancel under the same lease',
    );

    const current = await service.prepareOffer({ ...request, requestId: randomUUID() }),
      template = ccc.Transaction.fromBytes(current.unsignedBytes),
      changed = template.clone();
    changed.outputs[current.sponsorChangeOutputIndex].capacity += CKB;
    changed.outputs[current.ownerChangeOutputIndex].capacity -= CKB;
    await assert.rejects(
      () => verifySponsorOwnerWitness(client, current, ccc.hexFrom(changed.toBytes())),
      /changed the frozen/,
    );
    await assert.rejects(
      () =>
        service.submit({
          offerId: current.offerId,
          rawHash: current.rawHash,
          userSignedBytes: current.unsignedBytes,
        }),
      /Invalid owner transaction signature/,
    );
    assert.equal(broadcasts, 0);
    const ownerSigned = await owner.signOnlyTransaction(template.clone());
    const submission = {
      offerId: current.offerId,
      rawHash: current.rawHash,
      userSignedBytes: ownerSigned.toHex(),
    };
    const accepted = await service.submit(submission, true);
    assert.equal(accepted.ownerSignatureAccepted, true);
    assert.equal(accepted.state, 'owner-signed');
    assert.equal(accepted.signedBytes, undefined);
    assert.equal(broadcasts, 0, 'acceptance returns before sponsor signing or broadcast');
    assert.equal(service.store.load(current.offerId)?.userSignedBytes, ownerSigned.toHex());
    const duplicate = structuredClone(service.store.load(current.offerId)!);
    duplicate.offer.offerId = randomUUID();
    duplicate.requestId = randomUUID();
    delete duplicate.userSignedBytes;
    duplicate.state = 'cancelled';
    service.store.save(duplicate);
    const duplicateStatus = await service.rejectUnsigned({
      offerId: duplicate.offer.offerId,
      rawHash: duplicate.offer.rawHash,
    });
    assert.equal(
      duplicateStatus.unsignedRejection,
      undefined,
      'an accepted alias prevents a false no-payment proof',
    );

    const readCell = client.getCellLiveNoCache;
    client.getCellLiveNoCache = async () => {
      throw Error('RPC unavailable after acceptance');
    };
    try {
      assert.deepEqual(
        await service.submit(submission, true),
        accepted,
        'lost acknowledgement retries are idempotent without RPC',
      );
      await assert.rejects(
        service.submit({ ...submission, userSignedBytes: current.unsignedBytes }, true),
        /Another owner signature/,
      );
      await journal.exclusive(async () => {
        assert.deepEqual(
          service.receipt(submission),
          accepted,
          'receipt does not acquire the held spending lease',
        );
      });
    } finally {
      client.getCellLiveNoCache = readCell;
    }
    console.log(
      'PASS durable owner acceptance precedes signing, survives lost responses and reads without RPC or lease',
    );
    now = NOW + 3_700_000;
    const restarted = new BatchService({
      ...options,
      fixture: async () => {
        throw Error('No upstream refresh after accepted partial');
      },
    });
    const status = await restarted.status(
      { offerId: current.offerId, rawHash: current.rawHash },
      true,
    );
    assert.ok(status.signedBytes);
    assert.equal(status.state, 'blocked');
    assert.equal(broadcasts, 1);
    const operation = journal.load(
      operationKey('batch', picks[0].fixtureId, config.protocolHash, current.rawHash),
    )!;
    assert.equal(operation.creations?.length, 8);
    assert.equal(operation.signedTransaction, status.signedBytes);
    assert.equal((await operatorFundingBarrier(client, journal, registry)).clear, false);
    console.log(
      'PASS one owner signature and one durable batch survive expired quote and unknown delivery',
    );

    const committed = ccc.Transaction.fromBytes(status.signedBytes!);
    history.set(
      committed.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: committed,
        status: 'committed',
        blockHash: H('6'),
        blockNumber: 10,
      }),
    );
    for (const input of committed.inputs) cells.delete(input.previousOutput.toHex());
    for (const [i, output] of committed.outputs.entries()) {
      const cell = ccc.Cell.from({
        outPoint: { txHash: committed.hash(), index: i },
        cellOutput: output,
        outputData: committed.outputsData[i],
      });
      cells.set(cell.outPoint.toHex(), cell);
    }
    assert.equal(
      (await restarted.status({ offerId: current.offerId, rawHash: current.rawHash })).state,
      'funded',
    );
    assert.equal(registry.all().length, 8);
    assert.equal((await operatorFundingBarrier(client, journal, registry)).clear, true);
    const originalCreationRead = client.getTransactionNoCache;
    const originalLiveRead = client.getCellLiveNoCache;
    const originalHeaderRead = client.getHeaderByNumberNoCache;
    let creationReads = 0,
      liveReads = 0,
      headerReads = 0,
      activeReads = 0,
      maxReads = 0;
    client.getTransactionNoCache = async (...args) => {
      creationReads++;
      return originalCreationRead(...args);
    };
    client.getCellLiveNoCache = async (...args) => {
      liveReads++;
      maxReads = Math.max(maxReads, ++activeReads);
      try {
        await new Promise((done) => setTimeout(done, 15));
        return await originalLiveRead(...args);
      } finally {
        activeReads--;
      }
    };
    client.getHeaderByNumberNoCache = async (...args) => {
      headerReads++;
      return originalHeaderRead(...args);
    };
    await loadOperatorMarket(client, registry.all()[0], config);
    assert.equal(creationReads, 1, 'One immutable transaction read for shared creation outputs');
    assert.equal(liveReads, 5);
    assert.equal(
      headerReads,
      1,
      'Cells committed in the same block share one fresh canonical-header observation',
    );
    assert.equal(maxReads, 4, 'Five fresh live-cell reads overlap in bounded batches');
    assert.equal(activeReads, 0, 'Started reads are drained before returning');
    await loadOperatorMarket(client, registry.all()[0], config);
    assert.equal(creationReads, 2, 'Creation lookup is not cached between operations');
    assert.equal(headerReads, 2, 'A new operation rechecks the canonical block');
    client.getHeaderByNumberNoCache = async () => header(H('9'), 10);
    await assert.rejects(
      () => loadOperatorMarket(client, registry.all()[0], config),
      /no longer canonical/,
    );
    client.getTransactionNoCache = originalCreationRead;
    client.getCellLiveNoCache = originalLiveRead;
    client.getHeaderByNumberNoCache = originalHeaderRead;
    console.log(
      'PASS funded market reads: five creation lookups become one, fresh live cells and reorg rejection retained',
    );
    const canonicalCells = new Map(cells);
    history.delete(committed.hash());
    cells.clear();
    cells.set(fund.outPoint.toHex(), fund);
    cells.set(user.outPoint.toHex(), user);
    const beforeReorg = broadcasts;
    const automatic = await restarted.recoverPending();
    assert.equal(
      broadcasts,
      beforeReorg + 1,
      'confirmed batch is automatically revisited after a deep reorg',
    );
    assert.equal(automatic[0].state, 'blocked');
    assert.equal(
      restarted.store.load(current.offerId)?.signedBytes,
      status.signedBytes,
      'recovery preserves the original whole-slip bytes',
    );
    history.set(
      committed.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: committed,
        status: 'committed',
        blockHash: H('6'),
        blockNumber: 10,
      }),
    );
    cells.clear();
    for (const [key, cell] of canonicalCells) cells.set(key, cell);
    await restarted.status({ offerId: current.offerId, rawHash: current.rawHash });
    now = NOW;
    const fundedRequest = {
      requestId: randomUUID(),
      ownerAddress,
      userInputs: [{ txHash: committed.hash(), index: 41 }],
      picks: [picks[0]],
    };
    const firstFunded = await service.prepareOffer(fundedRequest);
    await service.cancelReview(fundedRequest.requestId, ownerAddress);
    const nextFunded = await service.prepareOffer({ ...fundedRequest, requestId: randomUUID() });
    assert.equal(firstFunded.lines[0].mode, 'deposit');
    assert.notEqual(
      nextFunded.rawHash,
      firstFunded.rawHash,
      'a fresh review cannot revive a retired hash',
    );
    assert.equal(BigInt(nextFunded.feeShannons), BigInt(firstFunded.feeShannons) + 1n);
    assert.deepEqual(nextFunded.inputs, firstFunded.inputs);
    assert.equal(nextFunded.reserveShannons, firstFunded.reserveShannons);
    assert.equal(
      ccc.Transaction.fromBytes(nextFunded.unsignedBytes).outputs[
        nextFunded.sponsorChangeOutputIndex
      ].capacity,
      ccc.Transaction.fromBytes(firstFunded.unsignedBytes).outputs[
        firstFunded.sponsorChangeOutputIndex
      ].capacity,
    );
    assert.equal(service.store.load(firstFunded.offerId)?.offer.rawHash, firstFunded.rawHash);
    assert.equal(service.store.load(firstFunded.offerId)?.state, 'cancelled');
    assert.equal(
      (
        await service.prepareOffer({
          ...fundedRequest,
          requestId: service.store.load(nextFunded.offerId)!.requestId,
        })
      ).rawHash,
      nextFunded.rawHash,
      'same request retains its exact review',
    );
    await service.cancelReview(service.store.load(nextFunded.offerId)!.requestId, ownerAddress);
    console.log(
      'PASS identical fresh funded reviews get distinct hashes without changing signed history',
    );
    const nextDemand = await service.describe('api-football-9010'),
      mixed = await service.prepareOffer({
        requestId: randomUUID(),
        ownerAddress,
        userInputs: [{ txHash: committed.hash(), index: 41 }],
        picks: [
          picks[0],
          {
            fixtureId: nextDemand.fixtureId,
            termsHash: nextDemand.termsHash,
            outcome: 2,
            principalShannons: (200n * CKB).toString(),
          },
        ],
      });
    assert.deepEqual(
      mixed.lines.map((line) => line.mode),
      ['deposit', 'create'],
    );
    assert.equal(mixed.reserveShannons, (3050n * CKB).toString());
    assert.equal(mixed.lines[1].outputIndex, 1);
    assert.equal(mixed.lines[0].shardInputIndex, 2);
    const mixedTx = ccc.Transaction.fromBytes(mixed.unsignedBytes);
    assert.equal(mixedTx.outputsData[0].slice(0, 10), '0x01000101');
    assert.equal(mixedTx.headerDeps.length, 1);
    assert.equal(mixedTx.outputs.length, 8);
    const mixedSigned = await owner.signOnlyTransaction(mixedTx.clone());
    const removed = cells.get(mixedTx.inputs[2].previousOutput.toHex())!;
    cells.delete(removed.outPoint.toHex());
    await assert.rejects(
      () =>
        service.submit({
          offerId: mixed.offerId,
          rawHash: mixed.rawHash,
          userSignedBytes: ccc.hexFrom(mixedSigned.toBytes()),
        }),
      /input changed/,
    );
    assert.equal(service.store.load(mixed.offerId)?.userSignedBytes, undefined);
    cells.set(removed.outPoint.toHex(), removed);
    console.log(
      'PASS atomic publication, mixed existing/new entry and stale shard fail before co-signing',
    );
    const secret = 'a'.repeat(64),
      server = createSponsorServer(service, secret, service);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await fetch(`${endpoint}/health`)).status, 401);
      const configurationBeforeHealth = service.configuration;
      let releaseConfiguration!: () => void;
      let started = 0;
      const held = new Promise<void>((resolve) => {
        releaseConfiguration = resolve;
      });
      service.configuration = async () => {
        started++;
        await held;
        throw Error('Synthetic unavailable chain configuration');
      };
      const requests = Array.from({ length: 4 }, () =>
        fetch(`${endpoint}/batch/configuration`, {
          headers: { authorization: `Bearer ${secret}` },
        }),
      );
      try {
        const deadline = Date.now() + 3000;
        while (started < 4 && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(started, 4);
        assert.equal(
          (
            await fetch(`${endpoint}/batch/configuration`, {
              headers: { authorization: `Bearer ${secret}` },
            })
          ).status,
          429,
        );
        const health = await fetch(`${endpoint}/health`, {
          headers: { authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(1000),
        });
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), {
          service: 'streak-sponsor',
          ready: true,
          batchEnabled: true,
        });
        assert.equal(started, 4, 'health never invokes payment configuration');
        const receipt = await fetch(
          `${endpoint}/batch/status?offerId=${mixed.offerId}&rawHash=${mixed.rawHash}`,
          {
            headers: { authorization: `Bearer ${secret}` },
            signal: AbortSignal.timeout(1000),
          },
        );
        assert.equal(receipt.status, 200, 'saved receipt bypasses saturated RPC slots');
        assert.equal(
          ((await receipt.json()) as { transactionHash: string }).transactionHash,
          mixed.rawHash,
        );
        assert.equal(started, 4);
      } finally {
        releaseConfiguration();
        await Promise.all(
          requests.map(async (request) => {
            const response = await request;
            await response.arrayBuffer();
          }),
        );
        service.configuration = configurationBeforeHealth;
      }
      assert.equal((await fetch(`${endpoint}/batch/configuration`)).status, 401);
      const response = await fetch(`${endpoint}/batch/configuration`, {
          headers: { authorization: `Bearer ${secret}` },
        }),
        configuration = (await response.json()) as { reservations: unknown[] };
      assert.equal(response.status, 200);
      assert.equal(configuration.reservations.length, 1, 'only new creation holds a whole fixture');
      assert.deepEqual(Object.keys(configuration).sort(), ['reservations', 'sponsorLock']);
      const before = broadcasts;
      await fetch(`${endpoint}/batch/status?offerId=${mixed.offerId}&rawHash=${mixed.rawHash}`, {
        headers: { authorization: `Bearer ${secret}` },
      });
      assert.equal(broadcasts, before);
      for (const action of ['resume', 'submit', 'resolve'])
        assert.equal(
          (
            await fetch(`${endpoint}/batch/${action}`, {
              method: 'POST',
              headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
              body: JSON.stringify({
                authenticatedOwnerAddress: await sponsor.getRecommendedAddress(),
                request: {
                  offerId: mixed.offerId,
                  rawHash: mixed.rawHash,
                  userSignedBytes: ccc.hexFrom(mixedSigned.toBytes()),
                  conflictingTxHash: H('e'),
                },
              }),
            })
          ).status,
          403,
        );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
    console.log(
      'PASS atomic IPC separates public reads and authenticated owner mutation without key exposure',
    );
    cancelUnsignedSponsorOffers(journal.directory);
    const oldRegistry = new DirectRegistry(join(directory, 'older'));
    for (const [id, pending] of [
      ['api-football-9020', true],
      ['api-football-9021', false],
    ] as const) {
      const type = ccc.Script.from({
          ...current.lines[0].descriptor.type,
          codeHash: PUBLIC_DIRECT_CONFIG.protocolHash,
        }),
        guard = {
          codeHash: PUBLIC_DIRECT_CONFIG.guardHash,
          hashType: 'data2' as const,
          args: type.hash(),
        };
      const oldTx = ccc.Transaction.from({
        inputs: [{ previousOutput: { txHash: H('d'), index: pending ? 0 : 1 } }],
        outputs: Array.from({ length: 5 }, (_, i) => ({
          capacity: (610n + (pending && i === 1 ? 421n : 0n)) * CKB,
          lock: guard,
          type,
        })),
        outputsData: [
          '0x0000ff',
          pending ? template.outputsData[1] : '0x01000000',
          '0x01010000',
          '0x01020000',
          '0x01030000',
        ],
      });
      // Distinct args keep the fake legacy fixtures independent without a shared pool.
      oldTx.outputs.forEach((output) => {
        output.type = ccc.Script.from({
          ...type,
          args: `0x${pending ? '01' : '02'}${type.args.slice(4)}`,
        });
        output.lock = ccc.Script.from({ ...guard, args: output.type.hash() });
      });
      const oldRecord = createRecord(
        fixture(id),
        { ...oldTx.outputs[0].type!, hashType: 'data2' },
        oldTx.hash(),
      );
      oldRegistry.add(oldRecord);
      history.set(
        oldTx.hash(),
        ccc.ClientTransactionResponse.from({
          transaction: oldTx,
          status: 'committed',
          blockHash: H('6'),
          blockNumber: 10,
        }),
      );
      oldTx.outputs.forEach((output, index) => {
        const cell = ccc.Cell.from({
          outPoint: { txHash: oldTx.hash(), index },
          cellOutput: output,
          outputData: oldTx.outputsData[index],
        });
        cells.set(cell.outPoint.toHex(), cell);
      });
    }
    const migration = new BatchService({ ...options, existingRegistry: [oldRegistry] });
    for (const [id, blocked] of [
      ['api-football-9020', true],
      ['api-football-9021', false],
    ] as const) {
      const demand = await migration.describe(id),
        attempt = {
          requestId: randomUUID(),
          ownerAddress,
          userInputs: [{ txHash: committed.hash(), index: 41 }],
          picks: [
            {
              fixtureId: id,
              termsHash: demand.termsHash,
              outcome: 0,
              principalShannons: (100n * CKB).toString(),
            },
          ],
        };
      if (blocked)
        await assert.rejects(() => migration.prepareOffer(attempt), /positions in an earlier pool/);
      else assert.equal((await migration.prepareOffer(attempt)).lines[0].mode, 'create');
    }
    assert.equal(oldRegistry.all().length, 2, 'retirement never deletes legacy descriptors');
    console.log(
      'PASS legacy populated pools cannot silently split; empty legacy pools retain exit history',
    );
    cancelUnsignedSponsorOffers(journal.directory);
    const actualAll = registry.all.bind(registry),
      publicCount = actualAll().length;
    registry.all = () =>
      Array.from({ length: 255 }, (_, index) => ({
        ...actualAll()[0],
        fixtureId: `api-football-${100_000 + index}`,
      }));
    const overLimitPicks = [];
    for (const id of ['api-football-9030', 'api-football-9031']) {
      const demand = await service.describe(id);
      overLimitPicks.push({
        fixtureId: id,
        termsHash: demand.termsHash,
        outcome: 0,
        principalShannons: (100n * CKB).toString(),
      });
    }
    const overLimit = {
      requestId: randomUUID(),
      ownerAddress,
      userInputs: [{ txHash: committed.hash(), index: 41 }],
      picks: overLimitPicks,
    };
    const proposalCount = service.store.all().length,
      beforeLimit = broadcasts;
    try {
      await assert.rejects(() => service.prepareOffer(overLimit), /testnet market limit/);
    } finally {
      registry.all = actualAll;
    }
    assert.equal(registry.all().length, publicCount);
    assert.equal(service.store.all().length, proposalCount);
    assert.equal(broadcasts, beforeLimit);
    console.log(
      'PASS complete-basket publication capacity is checked before any signature or reservation',
    );
    cancelUnsignedSponsorOffers(journal.directory);
    const conflict = ccc.Transaction.from({
      inputs: [{ previousOutput: user.outPoint }],
      outputs: [{ capacity: user.cellOutput.capacity - 1000n, lock: ownerLock }],
      outputsData: ['0x'],
      witnesses: ['0x00'],
    });
    history.delete(committed.hash());
    for (const [key, cell] of cells)
      if (cell.outPoint.txHash === committed.hash()) cells.delete(key);
    cells.set(fund.outPoint.toHex(), fund);
    const replacementOwner = ccc.Cell.from({
      outPoint: { txHash: conflict.hash(), index: 0 },
      cellOutput: conflict.outputs[0],
      outputData: '0x',
    });
    cells.set(replacementOwner.outPoint.toHex(), replacementOwner);
    history.set(
      conflict.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: conflict,
        status: 'committed',
        blockHash: H('9'),
        blockNumber: 11,
      }),
    );
    client.getHeaderByNumberNoCache = async (number) =>
      header(
        ccc.numFrom(number) === 11n ? H('9') : ccc.numFrom(number) === 12n ? H('a') : H('8'),
        Number(ccc.numFrom(number)),
      );
    client.getTipHeader = async () => header(H('b'), 15);
    history.set(
      fundingTx.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: fundingTx,
        status: 'committed',
        blockHash: H('8'),
        blockNumber: 10,
      }),
    );
    await service.resolveConflict({
      offerId: current.offerId,
      rawHash: current.rawHash,
      conflictingTxHash: conflict.hash(),
    });
    const recoveryConfig = await service.configuration();
    assert.equal(recoveryConfig.retiredCreations?.length, 8);
    const recoveryFixture = await service.describe(picks[0].fixtureId);
    assert.equal(recoveryFixture.state, 'available');
    assert.equal(recoveryFixture.descriptor, undefined);
    const replacement = await service.prepareOffer({
      requestId: randomUUID(),
      ownerAddress,
      userInputs: [{ txHash: conflict.hash(), index: 0 }],
      picks: [{ ...picks[0], outcome: 2, principalShannons: (200n * CKB).toString() }],
    });
    assert.equal(replacement.lines[0].mode, 'create');
    assert.deepEqual(replacement.sponsorInput, current.sponsorInput);
    assert.equal(
      registry.get(picks[0].fixtureId)?.creationTxHash,
      current.rawHash,
      'old selection is retained until replacement is canonical',
    );
    const replacementPartial = await owner.signOnlyTransaction(
        ccc.Transaction.fromBytes(replacement.unsignedBytes),
      ),
      replacementStatus = await service.submit({
        offerId: replacement.offerId,
        rawHash: replacement.rawHash,
        userSignedBytes: replacementPartial.toHex(),
      });
    const replacementTx = ccc.Transaction.fromBytes(replacementStatus.signedBytes!);
    history.set(
      replacementTx.hash(),
      ccc.ClientTransactionResponse.from({
        transaction: replacementTx,
        status: 'committed',
        blockHash: H('a'),
        blockNumber: 12,
      }),
    );
    for (const input of replacementTx.inputs) cells.delete(input.previousOutput.toHex());
    replacementTx.outputs.forEach((output, index) => {
      const cell = ccc.Cell.from({
        outPoint: { txHash: replacementTx.hash(), index },
        cellOutput: output,
        outputData: replacementTx.outputsData[index],
      });
      cells.set(cell.outPoint.toHex(), cell);
    });
    assert.equal(
      (await service.status({ offerId: replacement.offerId, rawHash: replacement.rawHash })).state,
      'funded',
    );
    assert.equal(registry.get(picks[0].fixtureId)?.creationTxHash, replacement.rawHash);
    assert.equal(service.store.load(current.offerId)?.signedBytes, status.signedBytes);
    assert.equal((await operatorFundingBarrier(client, journal, registry)).clear, true);
    console.log(
      'PASS a published orphan with canonical owner conflict can be replaced without losing history',
    );
  } finally {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('streak-batch-'))
      throw Error('Unsafe test cleanup target');
    rmSync(target, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
