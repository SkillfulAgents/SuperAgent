import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { installVolumeStop } from './volume-stop';

afterEach(() => vi.useRealTimers());
function setup(timeout = 40) {
  const dependencies = {
    hasVolumes: () => true,
    stopWriters: vi.fn(async () => {}),
    drain: vi.fn(async () => true),
    finish: vi.fn(async (drained: boolean) => ({ drained, recovered: drained ? 0 : 1, recoveryErrors: 0 })),
  };
  const app = new Hono();
  installVolumeStop(app, dependencies, timeout);
  app.post('/sessions', c => c.json({ started: true }));
  return { app, dependencies };
}

describe('bounded volume stop', () => {
  it('closes writers before draining and coalesces repeated stop calls', async () => {
    const { app, dependencies: d } = setup();
    d.drain.mockImplementation(async () => { expect(d.stopWriters).toHaveBeenCalledOnce(); return true; });
    const [a, b] = await Promise.all([app.request('/volumes/prepare-stop', { method: 'POST' }), app.request('/volumes/prepare-stop', { method: 'POST' })]);
    expect(await a.json()).toEqual({ drained: true, recovered: 0, recoveryErrors: 0 });
    expect(b.status).toBe(200);
    expect(d.finish).toHaveBeenCalledExactlyOnceWith(true);
    expect((await app.request('/sessions', { method: 'POST' })).status).toBe(503);
  });

  it.each(['writers', 'uploads', 'refused'])('preserves cache and accepts shutdown when %s do not finish', async failure => {
    const { app, dependencies: d } = setup();
    if (failure === 'writers') d.stopWriters.mockImplementation(() => new Promise(() => {}));
    else if (failure === 'uploads') d.drain.mockImplementation(() => new Promise(() => {}));
    else d.drain.mockResolvedValue(false);
    const response = await app.request('/volumes/prepare-stop', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drained: false, recovered: 1, recoveryErrors: 0 });
    expect(d.finish).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('reports failed preservation and still accepts shutdown', async () => {
    const { app, dependencies: d } = setup();
    d.drain.mockResolvedValue(false);
    d.finish.mockRejectedValue(new Error('workspace unavailable'));
    const response = await app.request('/volumes/prepare-stop', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ drained: false, recoveryErrors: 1 });
  });

  it('does no work for an agent without volumes', async () => {
    const { app, dependencies: d } = setup();
    d.hasVolumes = () => false;
    expect((await app.request('/volumes/prepare-stop', { method: 'POST' })).status).toBe(200);
    expect(d.stopWriters).not.toHaveBeenCalled();
  });
});
