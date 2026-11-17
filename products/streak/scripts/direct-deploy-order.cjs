'use strict';
// Explicit operator-only command. Never loads .env or prints keys/signed bytes.
const fs = require('node:fs');
const path = require('node:path');
const ccc = require('@ckb-ccc/core');
const { OperatorJournal, OperatorBusyError } = require('../dist/modules/direct/journal.js');
const { DirectRegistry, PUBLIC_DIRECT_CONFIG } = require('../dist/modules/direct/registry.js');
const {
  OrderDeploymentError,
  prepareOrderDeployment,
  reconcileOrderDeployment,
} = require('../dist/modules/direct/order-deployment.js');
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['prepare', 'status', 'broadcast'].includes(args[0]))
    throw new OrderDeploymentError('Usage: direct-deploy-order.cjs prepare|status|broadcast');
  const directory = process.env.STREAK_DIRECT_OPERATOR_DIR;
  const registry = process.env.STREAK_DIRECT_REGISTRY_DIR;
  if (
    !directory ||
    !registry ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(registry) ||
    path.resolve(directory) === path.resolve(registry)
  )
    throw new OrderDeploymentError(
      'Use the existing absolute durable operator and registry directories',
    );
  if (process.env.NODE_ENV === 'production' && process.env.STREAK_DIRECT_DURABLE_STATE_ACK !== '1')
    throw new OrderDeploymentError('Durable operator storage must be acknowledged');
  // Wait for brief payment/recovery work without taking over its lock.
  const journal = new OperatorJournal(directory, undefined, 10_000);
  const client = new ccc.ClientPublicTestnet({
    url: PUBLIC_DIRECT_CONFIG.rpc,
    fallbacks: [],
    timeout: 15000,
    maxConcurrent: 2,
  });
  if (args[0] === 'prepare') {
    if (!process.env.STREAK_DIRECT_PRIVATE_KEY)
      throw new OrderDeploymentError(
        'Set the existing operator key explicitly; no key file is loaded',
      );
    const code = fs.readFileSync(
      path.resolve(__dirname, '../contracts/direct-v5/deployment/streak-protocol-v5'),
    );
    const row = await prepareOrderDeployment(
      client,
      new ccc.SignerCkbPrivateKey(client, process.env.STREAK_DIRECT_PRIVATE_KEY),
      journal,
      new DirectRegistry(registry),
      code,
    );
    const tx = ccc.Transaction.fromBytes(row.signedTransaction);
    console.log(
      JSON.stringify(
        {
          transactionHash: row.transactionHash,
          codeCapacityShannons: tx.outputs[0].capacity.toString(),
          inputs: tx.inputs.length,
          broadcast: false,
          next: 'Review this deployment, then run broadcast. Keep deployment-v5.json for recovery.',
        },
        null,
        2,
      ),
    );
  } else
    console.log(
      JSON.stringify(
        await reconcileOrderDeployment(client, journal, args[0] === 'broadcast'),
        null,
        2,
      ),
    );
}
main().catch((error) => {
  console.error(
    error instanceof OperatorBusyError
      ? 'Operator busy after waiting 10 seconds. No deployment action started. Keep the lock and retry this command later.'
      : error instanceof OrderDeploymentError
        ? error.message
        : 'Deployment did not complete. Retain the durable record and run status before retrying.',
  );
  process.exitCode = 1;
});
