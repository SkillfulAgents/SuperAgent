import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVolumeStop } from './volume-stop';

afterEach(() => vi.useRealTimers());

describe('safe volume stop', () => {
  it('quiesces accepted writes, blocks new writers, and waits for uploads before allowing stop', async () => {
    let release!: () => void;
    const write = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    const app = new Hono();
    installVolumeStop(app, {
      hasVolumes: () => true,
      stopWriters: async () => { order.push('stopped'); },
      drain: async () => { order.push('drained'); return true; },
    });
    app.post('/write', async c => { await write; order.push('written'); return c.text('done'); });
    const accepted = app.request('/write', { method: 'POST' });
    const stopping = app.request('/volumes/prepare-stop', { method: 'POST' });
    expect((await app.request('/write', { method: 'POST' })).status).toBe(503);
    release();
    await accepted;
    expect((await stopping).status).toBe(200);
    expect(order).toEqual(['written', 'stopped', 'drained']);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(503);
  });

  it('declines a stop when uploads remain, and permits a later retry', async () => {
    const app = new Hono();
    const drain = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    installVolumeStop(app, { hasVolumes: () => true, stopWriters: async () => {}, drain });
    app.post('/write', c => c.text('done'));
    expect((await app.request('/volumes/prepare-stop', { method: 'POST' })).status).toBe(409);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/volumes/prepare-stop', { method: 'POST' })).status).toBe(200);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('recovers if the host never sends SIGTERM after a successful preparation', async () => {
    vi.useFakeTimers();
    const app = new Hono();
    installVolumeStop(app, { hasVolumes: () => true, stopWriters: async () => {}, drain: async () => true });
    app.post('/write', c => c.text('done'));
    expect((await app.request('/volumes/prepare-stop', { method: 'POST' })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200);
  });
});
