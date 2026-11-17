'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { setTimeout: delay } = require('node:timers/promises');
const { OperatorJournal, OperatorBusyError } = require('../dist/modules/direct/journal.js');
const source = fs.readFileSync(path.join(__dirname, '../scripts/direct-deploy-order.cjs'), 'utf8');
class OrderDeploymentError extends Error {}

async function runCli(directory, action, operation) {
  const logs = [],
    errors = [],
    waits = [],
    calls = [];
  const done = Promise.withResolvers();
  const fakeProcess = {
    argv: ['node', 'direct-deploy-order.cjs', action],
    env: {
      NODE_ENV: 'production',
      STREAK_DIRECT_DURABLE_STATE_ACK: '1',
      STREAK_DIRECT_OPERATOR_DIR: directory,
      STREAK_DIRECT_REGISTRY_DIR: path.join(directory, 'registry'),
      STREAK_DIRECT_PRIVATE_KEY: 'synthetic-key-never-used',
    },
    set exitCode(value) {
      this.result = value;
      done.resolve();
    },
  };
  const modules = {
    'node:fs': { readFileSync: () => Buffer.from('synthetic-code') },
    'node:path': path,
    '@ckb-ccc/core': {
      ClientPublicTestnet: class {},
      SignerCkbPrivateKey: class {},
      Transaction: { fromBytes: () => ({ outputs: [{ capacity: 4794100000000n }], inputs: [{}] }) },
    },
    '../dist/modules/direct/journal.js': {
      OperatorBusyError,
      OperatorJournal: class extends OperatorJournal {
        constructor(dir, config, wait) {
          super(dir, config, wait);
          waits.push(wait);
        }
      },
    },
    '../dist/modules/direct/registry.js': {
      DirectRegistry: class {},
      PUBLIC_DIRECT_CONFIG: { rpc: 'http://127.0.0.1:1' },
    },
    '../dist/modules/direct/order-deployment.js': {
      OrderDeploymentError,
      prepareOrderDeployment: async (_client, _signer, journal) => {
        calls.push('prepare');
        return journal.exclusive(() => operation(journal));
      },
      reconcileOrderDeployment: async (_client, journal, broadcast) => {
        calls.push(broadcast ? 'broadcast' : 'status');
        return journal.exclusive(() => operation(journal));
      },
    },
  };
  vm.runInNewContext(source, {
    require: (name) => {
      assert.ok(Object.hasOwn(modules, name), name);
      return modules[name];
    },
    __dirname: path.join(__dirname, '../scripts'),
    process: fakeProcess,
    console: {
      log: (value) => {
        logs.push(value);
        done.resolve();
      },
      error: (value) => errors.push(value),
    },
  });
  await done.promise;
  return { logs, errors, waits, calls, exitCode: fakeProcess.result };
}

async function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'streak-deploy-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

for (const action of ['prepare', 'status', 'broadcast']) {
  test(`${action} waits for the real journal owner to release and runs only once`, async (t) => {
    const directory = await temporary(t);
    const owner = new OperatorJournal(directory);
    const release = Promise.withResolvers();
    const ownership = owner.exclusive(() => release.promise);
    const lock = path.join(directory, 'operator.lock');
    const original = fs.readFileSync(lock, 'utf8');
    let executions = 0;
    const result = runCli(directory, action, () => {
      executions++;
      assert.notEqual(fs.readFileSync(lock, 'utf8'), original);
      return { transactionHash: 'synthetic-hash', signedTransaction: 'private-signed-bytes' };
    });
    try {
      await delay(150);
      assert.equal(executions, 0);
      assert.equal(fs.readFileSync(lock, 'utf8'), original);
    } finally {
      release.resolve();
      await ownership;
    }
    const output = await result;
    assert.deepEqual(output.waits, [10000]);
    assert.deepEqual(output.calls, [action]);
    assert.equal(executions, 1);
    assert.deepEqual(output.errors, []);
    if (action === 'prepare') {
      assert.equal(JSON.parse(output.logs[0]).broadcast, false);
      assert.doesNotMatch(output.logs.join(''), /private-signed-bytes|synthetic-key/);
    }
    assert.equal(fs.existsSync(lock), false);
  });
}

test('busy timeout preserves ownership and never enters deployment work', async (t) => {
  const directory = await temporary(t);
  const owner = new OperatorJournal(directory);
  const release = Promise.withResolvers();
  const ownership = owner.exclusive(() => release.promise);
  const lock = path.join(directory, 'operator.lock');
  const original = fs.readFileSync(lock, 'utf8');
  let executions = 0;
  try {
    const output = await runCli(directory, 'prepare', () => {
      executions++;
    });
    assert.equal(executions, 0);
    assert.equal(output.exitCode, 1);
    assert.match(output.errors[0], /Operator busy after waiting 10 seconds/);
    assert.equal(fs.readFileSync(lock, 'utf8'), original);
  } finally {
    release.resolve();
    await ownership;
  }
});

test('unexpected errors remain redacted and explicit deployment errors remain useful', async (t) => {
  const directory = await temporary(t);
  const secret = 'synthetic-private-key-and-signed-bytes';
  const unknown = await runCli(directory, 'prepare', () => {
    throw Error(secret);
  });
  assert.equal(unknown.exitCode, 1);
  assert.doesNotMatch(unknown.errors.join(''), new RegExp(secret));
  assert.match(unknown.errors[0], /run status before retrying/);
  const expected = await runCli(directory, 'status', () => {
    throw new OrderDeploymentError('Prepare and review a v5 deployment first');
  });
  assert.equal(expected.errors[0], 'Prepare and review a v5 deployment first');
});
