import * as ccc from '@ckb-ccc/core';
import { sponsoredWalletMode } from './sponsor';
import type { OrderOffer } from '../../../shared/order-wire';

/** Verify the complete wallet-only funding group, including a known parent change. */
export async function verifyOrderSignature(
  client: ccc.Client,
  offer: OrderOffer,
  bytes: string,
): Promise<ccc.Transaction> {
  if (!/^0x(?:[0-9a-f]{2})+$/.test(bytes) || bytes.length > 200_002)
    throw Error('Invalid order signature bytes');
  const template = ccc.Transaction.fromBytes(offer.unsignedBytes),
    signed = ccc.Transaction.fromBytes(bytes),
    owner = ccc.Script.from(offer.ownerLock);
  if (
    signed.hash() !== offer.rawHash ||
    template.hash() !== offer.rawHash ||
    signed.witnesses.length !== template.witnesses.length ||
    signed.witnesses.length !== signed.inputs.length ||
    signed.witnesses.slice(1).some((w) => w !== '0x')
  )
    throw Error('Wallet changed the reviewed order');
  for (const [i, cell] of offer.inputs.entries()) {
    template.inputs[i].cellOutput = ccc.CellOutput.from(cell.cellOutput);
    template.inputs[i].outputData = ccc.hexFrom(cell.outputData);
  }
  const witness = ccc.WitnessArgs.fromBytes(signed.witnesses[0]);
  if (witness.inputType || witness.outputType || !witness.lock)
    throw Error('Unexpected order witness metadata');
  const info = await template.getSignHashInfo(owner, client);
  if (!info || info.position !== 0) throw Error('Order wallet group changed');
  const mode = await sponsoredWalletMode(client, owner),
    lock = Buffer.from(ccc.bytesFrom(witness.lock));
  let valid = false;
  try {
    if (mode === 'native' && lock.length === 65)
      valid =
        ccc.hashCkbShort(ccc.recoverMessageSecp256k1(info.message, ccc.hexFrom(lock))) ===
        owner.args;
    if (
      mode === 'evm' &&
      lock.length === 85 &&
      lock.readUInt32LE(0) === 85 &&
      lock.readUInt32LE(4) === 16 &&
      lock.readUInt32LE(8) === 85 &&
      lock.readUInt32LE(12) === 85 &&
      lock.readUInt32LE(16) === 65 &&
      lock[84] <= 1
    )
      valid = ccc.verifyMessageEvmPersonal(
        `CKB transaction: ${info.message}`,
        ccc.hexFrom(lock.subarray(20)),
        `0x${owner.args.slice(4, 44)}`,
      );
  } catch {
    valid = false;
  }
  if (!valid) throw Error('Invalid order wallet signature');
  return signed;
}
