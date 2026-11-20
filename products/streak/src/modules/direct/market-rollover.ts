import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  object,
  validateRecord,
  V5_DIRECT_CONFIG,
  writeExclusiveJson,
  type DirectMarketRecord,
  type DirectProtocolConfig,
} from './registry';
import { parseProvisionCatalogue } from './provision';

const FILE = 'entry-rollovers-v5.json';
const LEGACY_CAMPAIGN_FILE = 'legacy-campaign-reservations.json';
const MAX_COMMITMENTS = 512;
const MAX_OPERATION = 32;
const RESERVE_SHANNONS = 3050n * 100_000_000n;

function fixtureIds(value: unknown, maximum: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== 'string' || !/^api-football-[1-9][0-9]{0,14}$/.test(id))
  )
    throw Error('Invalid market rollover fixture IDs');
  return value as string[];
}

function readCommitments(directory: string | undefined, filename: string): Set<string> {
  if (!directory) return new Set();
  const file = join(directory, filename);
  if (!existsSync(file)) return new Set();
  if (statSync(file).size > 64_000) throw Error('Market generation commitments exceed their bound');
  return new Set(fixtureIds(JSON.parse(readFileSync(file, 'utf8')), MAX_COMMITMENTS));
}

/** Public entry routing only. Earlier markets, signatures and funds are retained. */
export function readMarketRollovers(directory?: string): Set<string> {
  return readCommitments(directory, FILE);
}

/** Reservations survive failed or interrupted publication; nothing releases them automatically. */
export function readLegacyCampaignReservations(directory?: string): Set<string> {
  return readCommitments(directory, LEGACY_CAMPAIGN_FILE);
}

function commitCommitments(
  directory: string,
  filename: string,
  ids: string[],
  maximum: number,
): void {
  if (!isAbsolute(directory))
    throw Error('Generation commitments need the absolute v5 registry directory');
  fixtureIds(ids, maximum);
  if (!ids.length) throw Error('Choose explicit fixture IDs for the generation commitment');
  const previous = readCommitments(directory, filename);
  const next = [...new Set([...previous, ...ids])].sort();
  fixtureIds(next, MAX_COMMITMENTS);
  if (next.length === previous.size) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, filename);
  const temporary = `${file}.${randomUUID()}.next`;
  try {
    writeExclusiveJson(temporary, next);
    renameSync(temporary, file);
    if (process.platform !== 'win32') {
      const handle = openSync(directory, 'r');
      try {
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Caller holds the existing operator lease, including the conflicting-intent read below. */
export function commitMarketRollovers(directory: string, ids: string[]): void {
  fixtureIds(ids, MAX_OPERATION);
  const legacy = readLegacyCampaignReservations(directory);
  if (ids.some((id) => legacy.has(id)))
    throw Error(
      'A legacy competition publication already reserves this fixture; rollover is blocked',
    );
  commitCommitments(directory, FILE, ids, MAX_OPERATION);
}

/**
 * Reserve before publishing legacy campaign terms, under the same operator lease as rollover.
 * Failed publication keeps this conservative reservation. There is no automatic release.
 */
export function commitLegacyCampaignReservations(directory: string, ids: string[]): void {
  fixtureIds(ids, MAX_COMMITMENTS);
  const rollovers = readMarketRollovers(directory);
  if (ids.some((id) => rollovers.has(id)))
    throw Error(
      'This fixture already reserves v5 entry; legacy competition publication is blocked',
    );
  commitCommitments(directory, LEGACY_CAMPAIGN_FILE, ids, MAX_COMMITMENTS);
}

export function parseMarketRolloverArgs(args: string[]): { ids: string[]; apply: boolean } {
  const apply = args.includes('--apply');
  if (args.filter((arg) => arg === '--apply').length > 1) throw Error('Specify --apply only once');
  const ids = fixtureIds(
    args.filter((arg) => arg !== '--apply'),
    MAX_OPERATION,
  );
  if (!ids.length) throw Error('Usage: direct-rollover-markets.cjs [--apply] api-football-ID ...');
  return { ids, apply };
}

export interface MarketRolloverSnapshot {
  now: number;
  configuration: unknown;
  catalogue: unknown;
  localConfig: DirectProtocolConfig;
  earlier: DirectMarketRecord[];
  queued: DirectMarketRecord[];
  committed: ReadonlySet<string>;
  legacyCampaignReservations: ReadonlySet<string>;
}
export interface MarketRolloverPorts {
  /** Reads fresh loopback API state and existing local registries, without signing. */
  load(): Promise<MarketRolloverSnapshot>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  commit(ids: string[]): void;
}

function review(ids: string[], snapshot: MarketRolloverSnapshot) {
  const config = object(snapshot.configuration, 'queued payment configuration');
  const local = snapshot.localConfig;
  if (
    local.protocolHash !== V5_DIRECT_CONFIG.protocolHash ||
    local.codeDeps.length !== 2 ||
    config.enabled !== true ||
    config.onDemandMarkets !== true ||
    config.version !== V5_DIRECT_CONFIG.version ||
    config.network !== V5_DIRECT_CONFIG.network ||
    config.rpc !== V5_DIRECT_CONFIG.rpc ||
    config.protocolHash !== local.protocolHash ||
    config.guardHash !== local.guardHash ||
    !isDeepStrictEqual(config.codeDeps, local.codeDeps)
  )
    throw Error('The running API and local verified testnet v5 deployment must match');
  // Absence of this field means the deployed API cannot prove published pins are protected.
  const protectedIds = new Set(fixtureIds(config.protectedLegacyFixtureIds, MAX_COMMITMENTS));
  const catalogue = parseProvisionCatalogue(snapshot.catalogue, snapshot.now);
  const earlier = snapshot.earlier.map((record) => validateRecord(record));
  const queued = snapshot.queued.map((record) => validateRecord(record, local));
  const rows = ids.map((id) => {
    if (snapshot.legacyCampaignReservations.has(id))
      throw Error(`${id} retains a durable legacy competition publication reservation`);
    if (protectedIds.has(id))
      throw Error(`${id} retains a published competition's earlier payment rules`);
    const fixture = catalogue.fixtures.find((row) => row.fixtureId === id);
    if (!fixture || fixture.kickoffMs <= snapshot.now + 120_000)
      throw Error(`${id} must be a scheduled fixture more than two minutes before kickoff`);
    const previous = earlier.filter((record) => record.fixtureId === id);
    if (!previous.length || previous.some((record) => record.type.codeHash === local.protocolHash))
      throw Error(`${id} has no verified earlier market mapping`);
    if (previous.some((record) => record.cutoffMs !== fixture.kickoffMs))
      throw Error(`${id} changed kickoff; preserve the existing market and review its terms`);
    const current = queued.filter((record) => record.fixtureId === id);
    if (
      current.length > 1 ||
      current.some(
        (record) =>
          record.type.codeHash !== local.protocolHash || record.cutoffMs !== fixture.kickoffMs,
      )
    )
      throw Error(`${id} has conflicting v5 market terms`);
    return {
      fixtureId: id,
      label: fixture.label,
      kickoffAt: new Date(fixture.kickoffMs).toISOString(),
      alreadyQueued: snapshot.committed.has(id),
      marketRegistered: current.length === 1,
    };
  });
  const unregistered = rows.filter((row) => !row.marketRegistered).length;
  return {
    fixtures: rows,
    newCommitments: rows.filter((row) => !row.alreadyQueued).length,
    marketsAwaitingRegistration: unregistered,
    reservePerNewMarketCKB: '3050',
    reserveForUnregisteredMarketsShannons: (RESERVE_SHANNONS * BigInt(unregistered)).toString(),
    reserveForUnregisteredMarketsCKB: (3050n * BigInt(unregistered)).toString(),
    networkFees: 'Additional; the existing worker selects funding and verifies fees.',
    broadcast: false,
  };
}

/** Preview first; apply reads again under the same lease used by funding and recovery. */
export async function runMarketRollover(args: string[], ports: MarketRolloverPorts) {
  const { ids, apply } = parseMarketRolloverArgs(args);
  const preview = review(ids, await ports.load());
  if (!apply)
    return {
      status: 'preview' as const,
      ...preview,
      message: 'No changes made. Review the fixtures and reserve, then repeat with --apply.',
    };
  return ports.exclusive(async () => {
    const current = review(ids, await ports.load());
    ports.commit(ids);
    return {
      status: current.newCommitments ? ('queued' as const) : ('already-queued' as const),
      ...current,
      message:
        'New entries are committed to v5. This command does not deploy markets or broadcast. The existing worker prepares them; earlier payments and claims retain their original markets.',
    };
  });
}
