import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Match } from './types';
import {
  createRecord,
  PROVIDER_ORIGIN,
  V4_DIRECT_CONFIG,
  type DirectProtocolConfig,
} from './modules/direct/registry';
import { orderConfig } from './modules/direct/order-config';
import { OperatorJournal } from './modules/direct/journal';
import {
  commitMarketRollovers,
  commitLegacyCampaignReservations,
  readLegacyCampaignReservations,
  parseMarketRolloverArgs,
  readMarketRollovers,
  runMarketRollover,
  type MarketRolloverPorts,
  type MarketRolloverSnapshot,
} from './modules/direct/market-rollover';

const NOW = 1_800_000_000_000;
const H = (byte: string): `0x${string}` => `0x${byte.repeat(64)}`;
const config = orderConfig({ STREAK_ORDER_PROTOCOL_TX_HASH: H('a') });
const ids = ['api-football-1', 'api-football-2'];
function fixture(id: number): Match {
  return {
    id: `api-football-${id}`,
    sport: 'football',
    date: new Date(NOW).toISOString().slice(0, 10),
    kickoff: new Date(NOW + 3_600_000).toISOString(),
    status: 'scheduled',
    stage: 'Isolated test',
    home: { id: '1', name: 'Synthetic Home', code: 'H', flag: '' },
    away: { id: '2', name: 'Synthetic Away', code: 'A', flag: '' },
    oracle: {
      provider: 'api-football',
      source: PROVIDER_ORIGIN,
      fixtureId: String(id),
      status: 'NS',
    },
  };
}
function record(id: number, protocol: DirectProtocolConfig = V4_DIRECT_CONFIG) {
  const args = Buffer.alloc(172);
  args.writeBigUInt64LE(BigInt(Date.parse(fixture(id).kickoff)), 68);
  Buffer.from(protocol.guardHash.slice(2), 'hex').copy(args, 76);
  return createRecord(
    fixture(id),
    { codeHash: protocol.protocolHash, hashType: 'data2', args: `0x${args.toString('hex')}` },
    H('b'),
    protocol,
  );
}
function snapshot(): MarketRolloverSnapshot {
  return {
    now: NOW,
    localConfig: config,
    configuration: {
      ...config,
      enabled: true,
      onDemandMarkets: true,
      protectedLegacyFixtureIds: [],
    },
    catalogue: {
      format: 'streak-direct-fixtures-v1',
      provider: 'football',
      source: PROVIDER_ORIGIN,
      enabled: true,
      simulated: false,
      observedAtMs: NOW,
      coverage: { from: '2027-01-01', to: '2027-01-31', complete: true },
      fixtures: [fixture(1), fixture(2)],
    },
    earlier: [record(1), record(2)],
    queued: [],
    committed: new Set(),
    legacyCampaignReservations: new Set(),
  };
}
function harness(initial = snapshot(), following = initial) {
  let loads = 0;
  let held = false;
  let writes = 0;
  const commits: string[][] = [];
  const ports: MarketRolloverPorts = {
    async load() {
      loads++;
      if (loads === 2) assert.equal(held, true, 'apply rereads eligibility under the shared lease');
      return loads === 1 ? initial : following;
    },
    async exclusive(work) {
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
    commit(value) {
      assert.equal(held, true, 'routing mutation requires the shared operator lease');
      writes++;
      commits.push([...value]);
    },
  };
  return { ports, loads: () => loads, writes: () => writes, commits };
}
async function rejected(change: (value: MarketRolloverSnapshot) => void, pattern: RegExp) {
  const value = snapshot();
  change(value);
  const state = harness(value);
  await assert.rejects(runMarketRollover(['--apply', ...ids], state.ports), pattern);
  assert.equal(state.writes(), 0);
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'streak-rollover-'));
  try {
    const marker = join(directory, 'entry-rollovers-v5.json');
    const retained = join(directory, 'earlier-market.json');
    writeFileSync(retained, 'Original mapping and recovery remain untouched.');
    assert.deepEqual([...readMarketRollovers()], []);
    assert.deepEqual([...readMarketRollovers(directory)], []);
    commitMarketRollovers(directory, ids.slice(0, 1));
    commitMarketRollovers(directory, ids);
    const bytes = readFileSync(marker, 'utf8');
    commitMarketRollovers(directory, ids.slice().reverse());
    assert.equal(readFileSync(marker, 'utf8'), bytes, 'repeated apply is an idempotent no-op');
    assert.deepEqual([...readMarketRollovers(directory)], ids);
    assert.equal(readFileSync(retained, 'utf8'), 'Original mapping and recovery remain untouched.');
    assert.throws(() => commitMarketRollovers(directory, ['../operator.lock']));
    assert.throws(() => commitMarketRollovers(directory, [ids[0], ids[0]]));
    assert.throws(() => commitMarketRollovers(directory, []));
    assert.throws(() => commitMarketRollovers('.', ids));
    assert.throws(() => parseMarketRolloverArgs(['--apply', '--apply', ids[0]]));
    assert.throws(() => parseMarketRolloverArgs(['--unknown', ids[0]]));
    assert.throws(() => parseMarketRolloverArgs([]));
    assert.throws(() =>
      parseMarketRolloverArgs(Array.from({ length: 33 }, (_, n) => `api-football-${n + 1}`)),
    );
    writeFileSync(marker, JSON.stringify([ids[0], ids[0]]));
    assert.throws(() => readMarketRollovers(directory), /Invalid/);
    writeFileSync(marker, 'x'.repeat(64_001));
    assert.throws(() => readMarketRollovers(directory), /bound/);
    writeFileSync(
      marker,
      JSON.stringify(Array.from({ length: 512 }, (_, n) => `api-football-${n + 1}`)),
    );
    assert.throws(() => commitMarketRollovers(directory, ['api-football-513']), /Invalid/);
    console.log(
      'PASS durable bounded routing commitments preserve earlier state and are idempotent',
    );

    const journal = new OperatorJournal(join(directory, 'shared-operator'));
    const legacyFirst = join(directory, 'legacy-first');
    assert.deepEqual([...readLegacyCampaignReservations()], []);
    await journal.exclusive(async () => commitLegacyCampaignReservations(legacyFirst, [ids[0]]));
    // Publication is paused before its DB write. The API still reports no published pins.
    const staleApi = snapshot();
    assert.deepEqual(
      (staleApi.configuration as Record<string, unknown>).protectedLegacyFixtureIds,
      [],
    );
    staleApi.legacyCampaignReservations = readLegacyCampaignReservations(legacyFirst);
    const staleAttempt = harness(staleApi);
    await assert.rejects(
      runMarketRollover(['--apply', ...ids], staleAttempt.ports),
      /durable legacy/,
    );
    assert.equal(staleAttempt.writes(), 0);
    await journal.exclusive(async () => {
      assert.throws(
        () => commitMarketRollovers(legacyFirst, ids.slice().reverse()),
        /legacy competition/,
      );
    });
    assert.deepEqual(
      [...readMarketRollovers(legacyFirst)],
      [],
      'no partial rollover batch is written',
    );
    assert.deepEqual(
      [...readLegacyCampaignReservations(legacyFirst)],
      [ids[0]],
      'failed or paused publication never releases its reservation',
    );
    await journal.exclusive(async () => commitLegacyCampaignReservations(legacyFirst, [ids[0]]));
    assert.deepEqual(
      [...readLegacyCampaignReservations(legacyFirst)],
      [ids[0]],
      'reservation retry is idempotent',
    );
    const rolloverFirst = join(directory, 'rollover-first');
    await journal.exclusive(async () => commitMarketRollovers(rolloverFirst, [ids[0]]));
    await journal.exclusive(async () => {
      assert.throws(
        () => commitLegacyCampaignReservations(rolloverFirst, ids.slice().reverse()),
        /reserves v5/,
      );
    });
    assert.deepEqual(
      [...readLegacyCampaignReservations(rolloverFirst)],
      [],
      'no partial legacy reservation batch is written',
    );
    assert.deepEqual([...readMarketRollovers(rolloverFirst)], [ids[0]]);
    console.log(
      'PASS both serialized publication/rollover orders reject the conflicting intent despite stale API pins',
    );

    const previewState = harness();
    const preview = await runMarketRollover(ids, previewState.ports);
    assert.equal(preview.status, 'preview');
    assert.equal(preview.broadcast, false);
    assert.equal(preview.reserveForUnregisteredMarketsCKB, '6100');
    assert.equal(preview.reserveForUnregisteredMarketsShannons, '610000000000');
    assert.equal(preview.fixtures[0].label, 'Synthetic Home vs Synthetic Away');
    assert.equal(previewState.loads(), 1);
    assert.equal(previewState.writes(), 0);
    const applyState = harness();
    const applied = await runMarketRollover([...ids, '--apply'], applyState.ports);
    assert.equal(applied.status, 'queued');
    assert.equal(applied.broadcast, false);
    assert.equal(applyState.loads(), 2);
    assert.deepEqual(applyState.commits, [ids]);
    const existing = snapshot();
    existing.committed = new Set(ids);
    existing.queued = [record(1, config)];
    const repeated = await runMarketRollover(['--apply', ...ids], harness(existing).ports);
    assert.equal(repeated.status, 'already-queued');
    assert.equal(repeated.newCommitments, 0);
    assert.equal(repeated.reserveForUnregisteredMarketsCKB, '3050');
    console.log(
      'PASS preview/apply uses exact reserve arithmetic and fresh lease-protected eligibility',
    );

    await rejected((s) => {
      (s.configuration as Record<string, unknown>).enabled = false;
    }, /deployment/);
    await rejected((s) => {
      (s.configuration as Record<string, unknown>).protocolHash = H('c');
    }, /deployment/);
    await rejected((s) => {
      (s.configuration as Record<string, unknown>).network = 'mainnet';
    }, /deployment/);
    await rejected((s) => {
      (s.configuration as Record<string, unknown>).codeDeps = [];
    }, /deployment/);
    await rejected((s) => {
      delete (s.configuration as Record<string, unknown>).protectedLegacyFixtureIds;
    }, /Invalid/);
    await rejected((s) => {
      (s.configuration as Record<string, unknown>).protectedLegacyFixtureIds = [ids[1]];
    }, /published competition/);
    await rejected((s) => {
      s.earlier = [record(1)];
    }, /earlier market mapping/);
    await rejected((s) => {
      s.queued = [record(1, config), record(1, config)];
    }, /conflicting/);
    await rejected((s) => {
      (s.catalogue as Record<string, unknown>).observedAtMs = NOW - 121_000;
    }, /stale/);
    await rejected((s) => {
      const catalogue = s.catalogue as { fixtures: Match[] };
      catalogue.fixtures[1].kickoff = new Date(NOW + 120_000).toISOString();
    }, /two minutes/);
    await rejected((s) => {
      const catalogue = s.catalogue as { fixtures: Match[] };
      catalogue.fixtures[1].kickoff = new Date(NOW + 7_200_000).toISOString();
    }, /changed kickoff/);
    await rejected((s) => {
      (s.catalogue as { fixtures: Match[] }).fixtures[1].status = 'live';
    }, /scheduled/);
    const changed = snapshot();
    (changed.configuration as Record<string, unknown>).protectedLegacyFixtureIds = [ids[0]];
    const raced = harness(snapshot(), changed);
    await assert.rejects(
      runMarketRollover(['--apply', ...ids], raced.ports),
      /published competition/,
    );
    assert.equal(raced.loads(), 2);
    assert.equal(
      raced.writes(),
      0,
      'changed published pins cannot write a partially validated batch',
    );
    console.log(
      'PASS deployment, published pins, stale catalogue and racing changes fail closed without writes',
    );
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'streak-rollover-'))));
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
