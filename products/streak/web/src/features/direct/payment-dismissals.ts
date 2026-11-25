// Presentation preferences only. Never use these records to decide payment state,
// release inputs, delete receipts or stop recovery.
const storageKey = 'streak:payment-dismissals:v1';
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>;
export function paymentDismissalKey(account: string, payment: string, state: string): string {
  return JSON.stringify([account, payment, state]);
}
export function createPaymentDismissals(storage: () => Storage | null) {
  const memory = new Set<string>();
  const listeners = new Set<() => void>();
  function read(): string[] {
    try {
      const value: unknown = JSON.parse(storage()?.getItem(storageKey) ?? '[]');
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === 'string' && key.length <= 1024)
        : [];
    } catch {
      // Storage may be disabled. Keep dismissals for this document in memory.
      return [];
    }
  }
  function notify() {
    for (const listener of listeners) listener();
  }
  return {
    has(key: string) {
      return memory.has(key) || read().includes(key);
    },
    dismiss(key: string) {
      memory.add(key);
      try {
        const keys = [...new Set([...read(), ...memory])].slice(-1000);
        storage()?.setItem(storageKey, JSON.stringify(keys));
      } catch {
        // A preference write must never interrupt payment or receipt recovery.
      }
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    storageChanged(key: string | null) {
      if (key === storageKey || key === null) notify();
    },
  };
}

export const paymentDismissals = createPaymentDismissals(() =>
  typeof window === 'undefined' ? null : window.localStorage,
);
if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => paymentDismissals.storageChanged(event.key));
