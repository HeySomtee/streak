import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeExclusiveJson } from './registry';

/** Generation commitments, not payment reservations or permission to spend. */
export function queuedFixtureIds(directory: string): Set<string> {
  const file = join(directory, 'queued-fixtures-v5.json');
  if (!existsSync(file)) return new Set();
  if (statSync(file).size > 64_000) throw Error('Queued fixture commitments exceed their bound');
  return new Set(parseQueuedFixtureIds(JSON.parse(readFileSync(file, 'utf8'))));
}
export function parseQueuedFixtureIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== 'string' || !/^api-football-[1-9][0-9]{0,14}$/.test(id))
  )
    throw Error('Invalid queued fixture commitments');
  return value as string[];
}
/** Caller holds the shared operator lease across conflict checks and this write. */
export function commitQueuedFixtures(directory: string, ids: string[]): void {
  const combined = [...new Set([...queuedFixtureIds(directory), ...ids])].sort();
  parseQueuedFixtureIds(combined);
  const file = join(directory, 'queued-fixtures-v5.json');
  const temporary = `${file}.${randomUUID()}.next`;
  writeExclusiveJson(temporary, combined);
  renameSync(temporary, file);
  if (process.platform !== 'win32') {
    const handle = openSync(directory, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }
}
