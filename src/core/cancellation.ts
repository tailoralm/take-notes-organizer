/**
 * Cooperative cancellation for pipeline operations. A run creates an
 * AbortController and threads its signal down to the services and HTTP clients;
 * the "stop operation" API aborts it. Long loops and network calls observe the
 * signal and stop as soon as it fires.
 */
export class OperationCancelledError extends Error {
  constructor(message = 'Operation stopped by the user.') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

/** Throws {@link OperationCancelledError} when the signal has been aborted. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new OperationCancelledError();
}

/** Promise-based sleep that rejects as soon as the signal is aborted. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OperationCancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OperationCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
