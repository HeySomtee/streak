import * as ccc from '@ckb-ccc/core';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { OperatorJournal, reconcileOperation, type Reconciliation } from './journal';
import { DirectRegistry, V5_DIRECT_CONFIG, writeExclusiveJson } from './registry';
import {
  assertFreshOperatorInputs,
  loadOperatorDeployment,
  operatorFundingBarrier,
  type OperatorDeployment,
} from './cli';
import { confirmedFunding } from './atomic-reservations';

export class OrderDeploymentError extends Error {}

/** One shared journal and exact persisted bytes; this never activates queue admission. */
export async function prepareOrderDeployment(
  client: ccc.Client,
  signer: ccc.Signer,
  journal: OperatorJournal,
  registry: DirectRegistry,
  code: Uint8Array,
): Promise<OperatorDeployment> {
  if (code.length > 100_000 || ccc.hashCkb(code) !== V5_DIRECT_CONFIG.protocolHash)
    throw new OrderDeploymentError('Deployment binary differs from the pinned v5 script');
  return journal.exclusive(async () => {
    const existing = loadOperatorDeployment(journal, 'v5');
    if (existing) return existing;
    if (!(await operatorFundingBarrier(client, journal, registry)).clear)
      throw new OrderDeploymentError(
        'Reconcile outstanding operator payments before preparing deployment',
      );
    const lock = (await signer.getRecommendedAddressObj()).script;
    const output = ccc.CellOutput.from({ capacity: 0n, lock });
    output.capacity = BigInt(output.occupiedSize + code.length) * 100_000_000n;
    const minimumChange = BigInt(output.occupiedSize) * 100_000_000n;
    const required = output.capacity + minimumChange + 100_000_000n;
    const page = await client.findCellsPagedNoCache(
      { script: lock, scriptType: 'lock', scriptSearchMode: 'exact', withData: true },
      'desc',
      64,
    );
    if (page.cells.length > 64)
      throw new OrderDeploymentError('Deployment funding exceeds its collection bound');
    const cells: ccc.Cell[] = [];
    const seen = new Set<string>();
    let capacity = 0n;
    for (const cell of page.cells) {
      if (
        seen.has(cell.outPoint.toHex()) ||
        cell.cellOutput.type ||
        cell.outputData !== '0x' ||
        !cell.cellOutput.lock.eq(lock)
      )
        continue;
      seen.add(cell.outPoint.toHex());
      const candidate = ccc.Transaction.from({ inputs: [{ previousOutput: cell.outPoint }] });
      try {
        assertFreshOperatorInputs(journal, candidate);
      } catch {
        continue;
      }
      if (!(await confirmedFunding(client, cell))) continue;
      cells.push(cell);
      capacity += cell.cellOutput.capacity;
      if (capacity >= required) break;
    }
    if (capacity < required)
      throw new OrderDeploymentError(
        `Deployment needs ${required} shannons of confirmed unreserved capacity including change and fee reserve`,
      );
    const tx = ccc.Transaction.from({
      inputs: cells.map((cell) => ({ previousOutput: cell.outPoint })),
      outputs: [output, { capacity: capacity - output.capacity, lock }],
      outputsData: [ccc.hexFrom(code), '0x'],
    });
    const prepared = await signer.prepareTransaction(tx);
    const fee = prepared.estimateFee(1000n);
    if (fee > 100_000_000n) throw new OrderDeploymentError('Deployment fee exceeds one CKB');
    prepared.outputs[1].capacity -= fee;
    if (prepared.outputs[1].capacity < minimumChange || prepared.toBytes().length > 150_000)
      throw new OrderDeploymentError('Deployment exceeds capacity or size bounds');
    for (const cell of cells) {
      const live = await client.getCellLiveNoCache(cell.outPoint, true, false);
      if (
        !live ||
        live.cellOutput.toHex() !== cell.cellOutput.toHex() ||
        live.outputData !== cell.outputData
      )
        throw new OrderDeploymentError(
          'Deployment funding changed; no deployment was signed. Retry preparation.',
        );
    }
    assertFreshOperatorInputs(journal, prepared);
    const signed = await signer.signTransaction(prepared);
    if (signed.hash() !== prepared.hash())
      throw new OrderDeploymentError('Signing changed the deployment transaction');
    const row: OperatorDeployment = {
      protocolHash: V5_DIRECT_CONFIG.protocolHash,
      transactionHash: signed.hash(),
      signedTransaction: signed.toHex(),
      createdAtMs: Date.now(),
    };
    writeExclusiveJson(join(journal.directory, 'deployment-v5.json'), row);
    // Persist the new directory entry before returning any broadcastable authorization.
    if (process.platform !== 'win32') {
      const fd = openSync(journal.directory, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    return loadOperatorDeployment(journal, 'v5')!;
  });
}

export async function reconcileOrderDeployment(
  client: ccc.Client,
  journal: OperatorJournal,
  broadcast = false,
): Promise<Reconciliation> {
  return journal.exclusive(async () => {
    const row = loadOperatorDeployment(journal, 'v5');
    if (!row) throw new OrderDeploymentError('Prepare and review a v5 deployment first');
    const state = await reconcileOperation(client, row);
    if (!broadcast || state.status !== 'ready-to-rebroadcast') return state;
    const hash = await client.sendTransactionNoCache(
      ccc.Transaction.fromBytes(row.signedTransaction),
      'passthrough',
    );
    if (hash !== row.transactionHash)
      throw new OrderDeploymentError(
        'RPC returned another deployment hash; retain the original record',
      );
    return { transactionHash: hash, status: 'pending' };
  });
}
