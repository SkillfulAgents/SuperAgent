import type { Hono } from 'hono';
import { withinStopDeadline } from './stop-deadline';

/** Quiesce writers and drain uploads BEFORE Docker's short SIGTERM grace starts.
 * A failed drain leaves the container (and its only copy of queued bytes) alive. */
export function installVolumeStop(app: Hono, dependencies: {
  hasVolumes: () => boolean;
  stopWriters: (signal: AbortSignal) => Promise<void>;
  drain: (deadline: number, signal: AbortSignal) => Promise<boolean>;
}, timeoutMs = 25_000): void {
  let preparing: Promise<{ ready: boolean; workStopped: boolean }> | undefined;
  let quiescing = false;
  let readyUntil = 0;
  let writers = 0;

  app.use('*', async (c, next) => {
    if (c.req.path === '/volumes/prepare-stop' || c.req.path === '/health') return next();
    if (quiescing || Date.now() < readyUntil) {
      return c.json({ error: 'Agent is preparing to stop', inputAccepted: false }, 503);
    }
    // Browser RPCs belong to the running turn and can be long polls. Waiting
    // for them before interrupting that turn creates a shutdown dependency
    // cycle. Download is the exception: it writes a file directly.
    const browserRpc = c.req.path.startsWith('/browser/') && c.req.path !== '/browser/download';
    const writes = !browserRpc && (c.req.path.startsWith('/sessions') || !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method));
    if (writes) writers++;
    try { await next(); }
    finally { if (writes) writers--; }
  });

  app.post('/volumes/prepare-stop', async (c) => {
    if (!dependencies.hasVolumes()) return c.json({ ready: true, workStopped: false });
    if (Date.now() < readyUntil) return c.json({ ready: true, workStopped: true });
    if (!preparing) {
      preparing = (async () => {
        const deadline = Date.now() + timeoutMs;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Volume stop deadline exceeded')), timeoutMs);
        const { signal } = controller;
        let workStopped = false;
        try {
          // A disconnected account or a dead rclone must not interrupt the
          // user's turn just because they attempted a safe stop.
          if (!await withinStopDeadline(dependencies.drain(deadline, signal), signal)) return { ready: false, workStopped };
          signal.throwIfAborted();
          quiescing = true;
          // Accepted file writes/session starts must finish before the final
          // writer snapshot. New admissions are gated while we take it.
          while (writers > 0) {
            await withinStopDeadline(new Promise(resolve => setTimeout(resolve, 25)), signal);
          }
          signal.throwIfAborted();
          workStopped = true;
          await withinStopDeadline(dependencies.stopWriters(signal), signal);
          signal.throwIfAborted();
          // Closing active writers can enqueue more uploads after preflight.
          const ready = await withinStopDeadline(dependencies.drain(deadline, signal), signal);
          return { ready, workStopped };
        } catch (error) {
          console.error('[volumes] Could not prepare a safe stop:', error);
          return { ready: false, workStopped };
        } finally {
          clearTimeout(timer);
          controller.abort();
        }
      })().then(result => {
        // Hold writers out until SIGTERM, but recover if the host's stop fails.
        readyUntil = result.ready ? Date.now() + 15_000 : 0;
        quiescing = false;
        preparing = undefined;
        return result;
      });
    }
    const result = await preparing;
    return c.json(result, result.ready ? 200 : 409);
  });
}
