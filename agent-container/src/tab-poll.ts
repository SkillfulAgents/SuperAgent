/**
 * Ownership-tracked tab-list polling for the single-viewer browser stream.
 *
 * The stream endpoint allows one viewer at a time, but connections can
 * overlap during a reconnect: the new socket attaches before the old one's
 * close event fires. A bare module-level interval slot breaks both ways in
 * that window — assigning on connect leaks the previous timer (it polls
 * forever), and clearing the slot on the OLD socket's late close kills the
 * NEW viewer's polling. Each connection therefore keeps its own handle;
 * the shared slot only tracks which handle is current.
 */

let currentPoll: NodeJS.Timeout | null = null;

/** Start polling for a new viewer connection, replacing any previous viewer's timer. */
export function startTabPolling(poll: () => void, intervalMs = 2000): NodeJS.Timeout {
  const handle = setInterval(poll, intervalMs);
  if (currentPoll) clearInterval(currentPoll);
  currentPoll = handle;
  return handle;
}

/**
 * Stop one connection's polling. Only vacates the shared slot if that
 * connection is still the current viewer. Safe to call twice (a socket can
 * fire both 'error' and 'close').
 */
export function stopTabPolling(handle: NodeJS.Timeout): void {
  clearInterval(handle);
  if (currentPoll === handle) currentPoll = null;
}
