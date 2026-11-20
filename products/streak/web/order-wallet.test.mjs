import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const test = require('node:test');
require('../../../node_modules/ts-node').register({
  transpileOnly: true,
  skipProject: true,
  moduleTypes: { '**/*.ts': 'cjs' },
  compilerOptions: {
    module: 'CommonJS',
    target: 'ES2022',
    moduleResolution: 'node',
    verbatimModuleSyntax: false,
  },
});
const { ccc } = require('@ckb-ccc/core');
const { OrderClient, supportsOrderPayments } = require('./src/features/direct/order-client.ts');

test('JoyID and unknown payment formats stop before identity, funding, server preparation or signing', async (t) => {
  const calls = { identity: 0, chain: 0, fetch: 0, sign: 0 };
  t.mock.method(globalThis, 'fetch', async () => {
    calls.fetch++;
    throw Error('Unexpected request in unsupported payment preflight');
  });
  const picks = [
    {
      lineId: 'pick-1',
      marketId: 'test-market',
      matchId: 'api-football-1',
      outcome: 'away',
      amountCkb: '10000',
    },
  ];
  const original = structuredClone(picks);
  for (const signType of [ccc.SignerSignType.JoyId, 'UnknownFutureFormat']) {
    const signer = {
      signType,
      get client() {
        calls.chain++;
        throw Error('Unexpected chain read');
      },
      async getRecommendedAddressObj() {
        calls.identity++;
        throw Error('Unexpected identity read');
      },
      async signTransaction() {
        calls.sign++;
        throw Error('Unexpected signature');
      },
    };
    assert.equal(supportsOrderPayments(signer), false);
    await assert.rejects(
      new OrderClient(signer, {}).prepare(picks, 'synthetic-account'),
      /This wallet cannot place predictions yet.*No payment was sent/,
    );
  }
  assert.deepEqual(calls, { identity: 0, chain: 0, fetch: 0, sign: 0 });
  assert.deepEqual(picks, original, 'unsupported review preserves every draft amount and outcome');
});

test('Native CKB and EVM payment capabilities still enter their existing review path', async () => {
  for (const signType of [ccc.SignerSignType.CkbSecp256k1, ccc.SignerSignType.EvmPersonal]) {
    let identityReads = 0;
    const signer = {
      signType,
      async getRecommendedAddressObj() {
        identityReads++;
        throw Error('Existing identity path reached');
      },
    };
    assert.equal(supportsOrderPayments(signer), true);
    await assert.rejects(
      new OrderClient(signer, {}).prepare([], 'synthetic-account'),
      /Existing identity path reached/,
    );
    assert.equal(identityReads, 1);
  }
});
