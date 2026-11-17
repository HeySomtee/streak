import * as ccc from '@ckb-ccc/core';
import { V5_DIRECT_CONFIG, PUBLIC_DIRECT_CONFIG, type DirectProtocolConfig } from './registry';

/** An absent deployment stays disabled. Merely setting an environment flag cannot activate code. */
export function orderConfig(env: NodeJS.ProcessEnv = process.env): DirectProtocolConfig {
  const hash = env.STREAK_ORDER_PROTOCOL_TX_HASH;
  if (!hash) return V5_DIRECT_CONFIG;
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw Error('Invalid queued-payment deployment hash');
  return {
    ...V5_DIRECT_CONFIG,
    codeDeps: [
      { outPoint: { txHash: hash, index: 0 }, depType: 'code' },
      PUBLIC_DIRECT_CONFIG.codeDeps[1],
    ],
  };
}
export async function verifyOrderDeployment(
  client: ccc.Client,
  config: DirectProtocolConfig,
): Promise<void> {
  if (config.codeDeps.length !== 2) throw Error('Queued payments are not deployed');
  for (const [index, dep] of config.codeDeps.entries()) {
    const cell = await client.getCellLiveNoCache(dep.outPoint, true, false);
    const response = await client.getTransactionNoCache(dep.outPoint.txHash);
    if (
      !cell ||
      ccc.hashCkb(cell.outputData) !== (index === 0 ? config.protocolHash : config.guardHash) ||
      response?.status !== 'committed' ||
      !response.blockHash ||
      response.blockNumber === undefined ||
      response.transaction.hash() !== dep.outPoint.txHash ||
      response.transaction.outputsData[dep.outPoint.index] !== cell.outputData ||
      (await client.getHeaderByNumberNoCache(response.blockNumber))?.hash !== response.blockHash ||
      (await client.getTipHeader()).number < response.blockNumber + 3n
    )
      throw Error('Queued-payment deployment is not canonical and verified');
  }
}
