/**
 * Lets a screen stop WAITING for a long job (map analysis can take minutes) when the
 * hunter taps Cancel or leaves.
 *
 * `raceAbort` settles with a CancelledError the moment the signal aborts. It does not (and
 * cannot) stop the underlying work: a request already sent to the vision proxy runs to its
 * own timeout, and its result is thrown away. Cancelling does not bill anything extra, but
 * it does not save the proxy call either.
 */
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export const isCancelled = (e: unknown): boolean => e instanceof CancelledError || (e instanceof Error && e.name === 'CancelledError');

export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Nobody will read the work's result: keep a late rejection from surfacing as unhandled.
    work.catch(() => undefined);
    return Promise.reject(new CancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
