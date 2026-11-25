import { useState, useSyncExternalStore } from 'react';
import { paymentDismissals, paymentDismissalKey } from './payment-dismissals';

export function usePaymentDismissal(
  account: string,
  payment: string,
  state: string,
  pending: boolean,
  persist = true,
) {
  const key = paymentDismissalKey(account, payment, state);
  const [temporaryKey, setTemporaryKey] = useState<string | null>(null);
  const dismissed = useSyncExternalStore(
    paymentDismissals.subscribe,
    () => !pending && persist && paymentDismissals.has(key),
    () => false,
  );
  return {
    dismissed: dismissed || (!pending && !persist && temporaryKey === key),
    dismiss: () => {
      if (pending) return;
      if (persist) paymentDismissals.dismiss(key);
      else setTemporaryKey(key);
    },
  };
}
