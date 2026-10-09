import type { Hono } from 'hono';

/** Quiesce writers and drain uploads BEFORE Docker's short SIGTERM grace starts.
 * A failed drain leaves the container (and its only copy of queued bytes) alive. */
export function installVolumeStop(app: Hono, dependencies: {
  hasVolumes: () => boolean;
  stopWriters: () => Promise<void>;
  drain: (deadline: number) => Promise<boolean>;
}, timeoutMs = 25_000): void {
  let preparing: Promise<boolean> | undefined;
  let readyUntil = 0;
  let writers = 0;

  app.use('*', async (c, next) => {
    if (c.req.path === '/volumes/prepare-stop' || c.req.path === '/health') return next();
    if (preparing || Date.now() < readyUntil) {
      return c.json({ error: 'Agent is preparing to stop', inputAccepted: false }, 503);
    }
    const writes = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (writes) writers++;
    try { await next(); }
    finally { if (writes) writers--; }
  });

  app.post('/volumes/prepare-stop', async (c) => {
    if (!dependencies.hasVolumes()) return c.json({ ready: true });
    if (!preparing) {
      preparing = (async () => {
        const deadline = Date.now() + timeoutMs;
        // An accepted request may still be creating a session or writing a file.
        while (writers > 0 && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        if (writers > 0) return false;
        await dependencies.stopWriters();
        return dependencies.drain(deadline);
      })().catch(error => {
        console.error('[volumes] Could not prepare a safe stop:', error);
        return false;
      }).then(ready => {
        // Hold writers out until SIGTERM, but recover if the host's stop fails.
        readyUntil = ready ? Date.now() + 15_000 : 0;
        preparing = undefined;
        return ready;
      });
    }
    const ready = await preparing;
    return c.json({ ready }, ready ? 200 : 409);
  });
}
