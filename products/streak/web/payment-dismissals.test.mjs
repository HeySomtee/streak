import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPaymentDismissals,
  paymentDismissalKey,
} from './src/features/direct/payment-dismissals.ts';

function preferences() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
test('Dismissed receipts survive document restoration and stay scoped to account/payment/status', () => {
  const storage = preferences();
  const key = paymentDismissalKey('alice', 'order:one', 'placed');
  createPaymentDismissals(() => storage).dismiss(key);
  const restored = createPaymentDismissals(() => storage);
  assert.equal(restored.has(key), true);
  for (const other of [
    paymentDismissalKey('bob', 'order:one', 'placed'),
    paymentDismissalKey('alice', 'order:two', 'placed'),
    paymentDismissalKey('alice', 'order:one', 'refunded'),
    paymentDismissalKey('alice', 'batch:one', 'confirmed'),
  ])
    assert.equal(restored.has(other), false);
});
test('Separate tabs merge dismissals and notify subscribed presentations', () => {
  const storage = preferences();
  const first = createPaymentDismissals(() => storage);
  const second = createPaymentDismissals(() => storage);
  let updates = 0;
  const unsubscribe = first.subscribe(() => updates++);
  first.dismiss('one');
  second.dismiss('two');
  first.storageChanged('streak:payment-dismissals:v1');
  assert.equal(first.has('two'), true);
  assert.equal(second.has('one'), true);
  assert.equal(updates, 2);
  unsubscribe();
  first.dismiss('three');
  assert.equal(updates, 2);
});
test('Blocked storage keeps in-document dismissals and never throws into checkout', () => {
  const blocked = createPaymentDismissals(() => {
    throw Error('Storage disabled');
  });
  assert.equal(blocked.has('receipt'), false);
  assert.doesNotThrow(() => blocked.dismiss('receipt'));
  assert.equal(blocked.has('receipt'), true);
  const malformed = createPaymentDismissals(() => ({ getItem: () => '{broken', setItem() {} }));
  assert.equal(malformed.has('receipt'), false);
  malformed.dismiss('receipt');
  assert.equal(malformed.has('receipt'), true);
});
