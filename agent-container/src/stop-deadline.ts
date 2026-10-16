/** Bound shutdown work even when a dependency ignores cancellation. Callers
 * must also pass the signal through to any work with later side effects. */
export async function withinStopDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Stop deadline exceeded'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}
