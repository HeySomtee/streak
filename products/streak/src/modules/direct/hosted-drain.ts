import type { Server } from 'node:http';

/** Stop accepting work, then finish current requests and the current recovery pass. */
export function startHostedRecovery(
  server: Server,
  recover: () => Promise<void>,
  failed: () => void,
  intervalMs = 15_000,
): { stop: () => Promise<void> } {
  let closing = false;
  let current: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const wake = () => {
    if (closing || current) return;
    current = Promise.resolve()
      .then(recover)
      .catch(failed)
      .finally(() => {
        current = undefined;
      });
  };
  const interval = setInterval(wake, intervalMs);
  server.on('payment-accepted', wake);
  server.once('close', () => {
    clearInterval(interval);
    server.off('payment-accepted', wake);
  });
  return {
    stop() {
      if (stopping) return stopping;
      closing = true;
      clearInterval(interval);
      const drained = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      stopping = Promise.all([drained, current]).then(() => undefined);
      return stopping;
    },
  };
}
