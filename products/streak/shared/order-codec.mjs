import { ccc } from '@ckb-ccc/core';

export const ORDER_VERSION = 'queued-predictions-v1';
export const ORDER_PROTOCOL_HASH =
  '0x9f2de55c41d35ed55a90c858f582a9f662be79fdc6f210699c8c16214541fdb7';
export const ORDER_RESERVE = 10_100_000_000n;
export const ORDER_MAX_FEE = 100_000_000n;
export const ORDER_STORAGE = 32_100_000_000n;
const U64 = (1n << 64n) - 1n;
const hex32 = (value) => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value))
    throw Error('Invalid order hash');
  return value;
};
const uint = (value) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value))
    throw Error('Invalid order amount');
  const n = BigInt(value);
  if (n > U64) throw Error('Order amount overflow');
  return n;
};
const le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const concat = (parts) => {
  const b = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    b.set(p, i);
    i += p.length;
  }
  return b;
};

export function encodeOrder(ownerLike, lines, selectionDigest) {
  const owner = ccc.Script.from(ownerLike),
    ownerBytes = owner.toBytes();
  if (
    ccc.bytesFrom(owner.args).length > 59 ||
    !Array.isArray(lines) ||
    lines.length < 1 ||
    lines.length > 8
  )
    throw Error('Invalid order owner or slip size');
  const seen = new Set();
  let capacity = ORDER_RESERVE;
  let expiry = U64;
  const encoded = lines.map((line) => {
    const hash = hex32(line.marketHash),
      amount = uint(line.principalShannons);
    if (
      seen.has(hash) ||
      !Number.isSafeInteger(line.cutoffMs) ||
      line.cutoffMs <= 0 ||
      ![0, 1, 2].includes(line.outcome) ||
      amount < 10_000_000_000n ||
      amount > 100_000_000_000_000n
    )
      throw Error('Invalid or duplicate order prediction');
    seen.add(hash);
    const cutoff = BigInt(line.cutoffMs);
    expiry = expiry < cutoff ? expiry : cutoff;
    capacity += amount + ORDER_STORAGE;
    return concat([ccc.bytesFrom(hash), le(cutoff), new Uint8Array([line.outcome]), le(amount)]);
  });
  if (capacity > U64) throw Error('Order capacity overflow');
  const header = new Uint8Array([1, lines.length, ownerBytes.length & 255, ownerBytes.length >> 8]);
  return {
    data: ccc.hexFrom(
      concat([header, ownerBytes, le(expiry), ccc.bytesFrom(hex32(selectionDigest)), ...encoded]),
    ),
    capacity,
    expiry: Number(expiry),
  };
}

export function decodeOrder(value) {
  const b = ccc.bytesFrom(value);
  if (b.length < 4 || b[0] !== 1) throw Error('Invalid order data');
  const length = b[2] + 256 * b[3],
    count = b[1],
    base = 44 + length;
  if (length > 112 || count < 1 || count > 8 || b.length !== base + count * 49)
    throw Error('Invalid order layout');
  const owner = ccc.Script.fromBytes(b.slice(4, 4 + length));
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const selectionDigest = ccc.hexFrom(b.slice(12 + length, 44 + length));
  const lines = Array.from({ length: count }, (_, j) => {
    const i = base + 49 * j;
    return {
      marketHash: ccc.hexFrom(b.slice(i, i + 32)),
      cutoffMs: Number(view.getBigUint64(i + 32, true)),
      outcome: b[i + 40],
      principalShannons: view.getBigUint64(i + 41, true).toString(),
    };
  });
  const parsed = encodeOrder(owner, lines, selectionDigest);
  if (
    parsed.data !== ccc.hexFrom(b) ||
    BigInt(parsed.expiry) !== view.getBigUint64(4 + length, true)
  )
    throw Error('Noncanonical order data');
  return { ...parsed, owner, lines, selectionDigest };
}

export function orderLock(protocolHash, data) {
  decodeOrder(data);
  return ccc.Script.from({
    codeHash: hex32(protocolHash),
    hashType: 'data2',
    args: `0x05${ccc.hashCkb(data).slice(2)}`,
  });
}

export function orderFee(tx) {
  // 1,000 shannons/kB, rounded upward; include the serialized size prefix.
  const fee = BigInt(tx.toBytes().length + 4);
  if (fee > ORDER_MAX_FEE) throw Error('Order network fee exceeds the reviewed bound');
  return fee;
}

/** Shared wallet/server verification. A display object cannot change signed economics. */
export function validateOrderOffer(o, protocolHash = ORDER_PROTOCOL_HASH) {
  if (
    !o ||
    o.version !== ORDER_VERSION ||
    !/^[0-9a-f-]{36}$/.test(o.id) ||
    typeof o.unsignedBytes !== 'string' ||
    o.unsignedBytes.length > 200002 ||
    !Number.isSafeInteger(o.createdAt) ||
    !Number.isSafeInteger(o.expiresAt) ||
    o.expiresAt <= o.createdAt ||
    o.expiresAt > o.createdAt + 120000 ||
    !Array.isArray(o.inputs) ||
    o.inputs.length < 1 ||
    o.inputs.length > 24 ||
    !Array.isArray(o.markets) ||
    !Array.isArray(o.parents) ||
    o.parents.length > 3
  )
    throw Error('Invalid order review');
  const data = decodeOrder(o.orderData),
    tx = ccc.Transaction.fromBytes(o.unsignedBytes);
  const owner = ccc.Script.from(o.ownerLock);
  if (
    !owner.eq(data.owner) ||
    tx.hash() !== o.rawHash ||
    tx.inputs.length !== o.inputs.length ||
    tx.outputs.length !== 2 ||
    tx.outputsData.length !== 2 ||
    tx.outputs[0].type ||
    tx.outputs[1].type ||
    !tx.outputs[0].lock.eq(orderLock(protocolHash, data.data)) ||
    tx.outputs[0].capacity !== data.capacity ||
    tx.outputsData[0] !== data.data ||
    tx.outputsData[1] !== '0x' ||
    !tx.outputs[1].lock.eq(owner) ||
    o.capacityShannons !== data.capacity.toString() ||
    o.markets.length !== data.lines.length ||
    tx.headerDeps.length ||
    o.expiresAt > data.expiry ||
    tx.witnesses.length !== tx.inputs.length
  )
    throw Error('Order review differs from its funding transaction');
  let capacity = 0n;
  const points = new Set();
  o.inputs.forEach((cell, i) => {
    const c = ccc.Cell.from(cell),
      key = c.outPoint.toHex();
    if (
      points.has(key) ||
      !c.outPoint.eq(tx.inputs[i].previousOutput) ||
      tx.inputs[i].since !== 0n ||
      c.cellOutput.type ||
      c.outputData !== '0x' ||
      !c.cellOutput.lock.eq(owner)
    )
      throw Error('Invalid order funding inputs');
    points.add(key);
    capacity += c.cellOutput.capacity;
  });
  const fee = capacity - tx.outputs.reduce((n, o) => n + o.capacity, 0n);
  if (
    fee !== uint(o.networkFeeShannons) ||
    fee !== orderFee(tx) ||
    tx.outputs.some(
      (o, i) =>
        o.capacity <
        BigInt(o.occupiedSize + ccc.bytesFrom(tx.outputsData[i]).length) * 100_000_000n,
    )
  )
    throw Error('Invalid order funding fee or capacity');
  const fixtures = new Set();
  o.markets.forEach((m, i) => {
    const type = ccc.Script.from(m.type),
      args = ccc.bytesFrom(type.args),
      line = data.lines[i];
    if (
      fixtures.has(m.fixtureId) ||
      !/^api-football-[1-9][0-9]{0,14}$/.test(m.fixtureId) ||
      type.codeHash !== protocolHash ||
      type.hashType !== 'data2' ||
      args.length !== 172 ||
      type.hash() !== line.marketHash ||
      m.cutoffMs !== line.cutoffMs ||
      new DataView(args.buffer, args.byteOffset, args.byteLength).getBigUint64(68, true) !==
        BigInt(line.cutoffMs)
    )
      throw Error('Order market binding differs');
    fixtures.add(m.fixtureId);
    hex32(m.creationTxHash);
    hex32(m.termsHash);
  });
  for (const hash of o.parents)
    if (!o.inputs.some((c) => c.outPoint.txHash === hex32(hash) && c.outPoint.index === 1))
      throw Error('Invalid order parent');
  return o;
}
