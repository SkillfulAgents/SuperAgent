import type { Hono } from 'hono';
import { withinStopDeadline } from './stop-deadline';

/** One terminal, bounded preparation. Failure preserves files and continues
 * shutdown; it never refuses a stop or reopens the agent for new work. */
export function installVolumeStop(app: Hono, dependencies: {
  hasVolumes: () => boolean;
  stopWriters: () => Promise<void>;
  drain: (deadline: number) => Promise<boolean>;
  finish: (drained: boolean) => Promise<{ drained: boolean; recovered: number; recoveryErrors: number }>;
}, timeoutMs = 15_000): void {
  let preparing: ReturnType<typeof dependencies.finish> | undefined;
  let writers = 0;
  app.use('*', async (c, next) => {
    if (c.req.path === '/volumes/prepare-stop' || c.req.path === '/health') return next();
    if (preparing) return c.json({ error: 'Agent is stopping', inputAccepted: false }, 503);
    const browserRpc = c.req.path.startsWith('/browser/') && c.req.path !== '/browser/download';
    const writes = !browserRpc && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    if (writes) writers++;
    try { await next(); } finally { if (writes) writers--; }
  });
  app.post('/volumes/prepare-stop', async c => {
    if (!dependencies.hasVolumes()) return c.json({ drained: true, recovered: 0, recoveryErrors: 0 });
    preparing ??= (async () => {
      const deadline = Date.now() + timeoutMs;
      const signal = AbortSignal.timeout(timeoutMs);
      let drained = false;
      try {
        await withinStopDeadline(dependencies.stopWriters(), AbortSignal.timeout(Math.min(3_000, timeoutMs)));
        while (writers > 0) await withinStopDeadline(new Promise(resolve => setTimeout(resolve, 25)), signal);
        drained = await withinStopDeadline(dependencies.drain(deadline), signal);
      } catch (error) {
        console.error('[volumes] Drain incomplete; preserving workspace cache before stopping:', error);
      }
      try {
        return await withinStopDeadline(dependencies.finish(drained), AbortSignal.timeout(3_000));
      } catch (error) {
        console.error('[volumes] Recovery incomplete; original cache remains in the workspace:', error);
        return { drained: false, recovered: 0, recoveryErrors: 1 };
      }
    })();
    return c.json(await preparing);
  });
}
