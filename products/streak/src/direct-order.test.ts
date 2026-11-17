import assert from 'node:assert/strict';
import * as ccc from '@ckb-ccc/core';
import {
  decodeOrder,
  encodeOrder,
  orderLock,
  ORDER_PROTOCOL_HASH,
  ORDER_RESERVE,
  ORDER_STORAGE,
} from '../shared/order-codec.mjs';
const owner = ccc.Script.from({
  codeHash: `0x${'11'.repeat(32)}`,
  hashType: 'type',
  args: `0x${'22'.repeat(22)}`,
});
const lines = Array.from({ length: 8 }, (_, i) => ({
  marketHash: `0x${String(i + 1).padStart(64, '0')}`,
  cutoffMs: 1800000000000 + i * 1000,
  outcome: (i % 3) as 0 | 1 | 2,
  principalShannons: '10000000000',
}));
const encoded = encodeOrder(owner, lines, `0x${'00'.repeat(32)}`),
  decoded = decodeOrder(encoded.data);
assert.deepEqual(decoded.lines, lines);
assert(decoded.owner.eq(owner));
assert.equal(encoded.capacity, ORDER_RESERVE + 8n * (ORDER_STORAGE + 10000000000n));
assert.equal(encoded.expiry, lines[0].cutoffMs);
assert.equal(
  orderLock(ORDER_PROTOCOL_HASH, encoded.data).args,
  `0x05${ccc.hashCkb(encoded.data).slice(2)}`,
);
for (const bad of [
  [],
  [...lines, lines[0]],
  [lines[0], lines[0]],
  [{ ...lines[0], principalShannons: '099' }],
  [{ ...lines[0], principalShannons: '18446744073709551616' }],
  [{ ...lines[0], cutoffMs: NaN }],
])
  assert.throws(() => encodeOrder(owner, bad, `0x${'00'.repeat(32)}`));
for (const data of ['0x', '0x010101', encoded.data.slice(0, -2), `${encoded.data}00`])
  assert.throws(() => decodeOrder(data));
const altered = ccc.bytesFrom(encoded.data);
altered[4 + owner.toBytes().length] ^= 1;
assert.throws(() => decodeOrder(ccc.hexFrom(altered)), /Noncanonical/);
assert.throws(() =>
  encodeOrder({ ...owner, args: `0x${'22'.repeat(60)}` }, lines, `0x${'00'.repeat(32)}`),
);
console.log(
  'Queued order encoding binds exact owner, eight distinct markets, cutoffs, amounts, reserve and selection digest.',
);
