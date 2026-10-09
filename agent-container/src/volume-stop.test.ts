import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installVolumeStop } from './volume-stop';

afterEach(() => vi.useRealTimers());
const stop = (app: Hono) => app.request('/volumes/prepare-stop', { method: 'POST' });

describe('safe volume stop', () => {
  it('checks uploads, quiesces accepted writes, and drains files closed by stopped writers', async () => {
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
    const stopping = stop(app);
    await vi.waitFor(async () => expect((await app.request('/new-write', { method: 'POST' })).status).toBe(503));
    expect((await app.request('/write', { method: 'POST' })).status).toBe(503);
    release();
    await accepted;
    expect((await stopping).status).toBe(200);
    expect(order).toEqual(['drained', 'written', 'stopped', 'drained']);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(503);
  });

  it('leaves sessions and dashboards alone when the account is disconnected or rclone is dead', async () => {
    const app = new Hono();
    const drain = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const stopWriters = vi.fn();
    installVolumeStop(app, { hasVolumes: () => true, stopWriters, drain });
    app.post('/write', c => c.text('done'));
    const declined = await stop(app);
    expect(declined.status).toBe(409);
    expect(await declined.json()).toEqual({ ready: false, workStopped: false });
    expect(stopWriters).not.toHaveBeenCalled();
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200);
    expect((await stop(app)).status).toBe(200);
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('reports interrupted work if closing a writer enqueues an upload that cannot finish', async () => {
    const app = new Hono();
    const stopWriters = vi.fn();
    installVolumeStop(app, {
      hasVolumes: () => true, stopWriters,
      drain: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
    });
    const declined = await stop(app);
    expect(declined.status).toBe(409);
    expect(await declined.json()).toEqual({ ready: false, workStopped: true });
    expect(stopWriters).toHaveBeenCalledOnce();
  });

  it.each(['/browser/run', '/browser/wait'])('does not wait for a long %s request to stop its owning session', async path => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const app = new Hono();
    const stopWriters = vi.fn(async () => { release(); });
    installVolumeStop(app, { hasVolumes: () => true, stopWriters, drain: async () => true }, 100);
    app.post(path, async c => { await waiting; return c.text('done'); });
    const browser = app.request(path, { method: 'POST' });
    try {
      expect((await stop(app)).status).toBe(200);
      expect(stopWriters).toHaveBeenCalledOnce();
    } finally { release(); await browser; }
  });

  it.each(['drain', 'stopWriters'] as const)('bounds a hung %s and reopens admissions for retry', async hung => {
    vi.useFakeTimers();
    const app = new Hono();
    const never = () => new Promise<never>(() => {});
    const drain = vi.fn().mockResolvedValue(true);
    const stopWriters = vi.fn().mockResolvedValue(undefined);
    if (hung === 'drain') drain.mockImplementationOnce(never);
    else stopWriters.mockImplementationOnce(never);
    installVolumeStop(app, { hasVolumes: () => true, stopWriters, drain }, 100);
    app.post('/write', c => c.text('done'));
    const stopping = stop(app);
    await vi.advanceTimersByTimeAsync(101);
    const declined = await stopping;
    expect(declined.status).toBe(409);
    expect(await declined.json()).toEqual({ ready: false, workStopped: hung === 'stopWriters' });
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200);
    expect((await stop(app)).status).toBe(200);
  });

  it('does not interrupt sessions if an accepted file write has not finished', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const app = new Hono();
    const stopWriters = vi.fn();
    installVolumeStop(app, { hasVolumes: () => true, stopWriters, drain: async () => true }, 100);
    app.put('/files/upload', async c => { await waiting; return c.text('done'); });
    const upload = app.request('/files/upload', { method: 'PUT' });
    const stopping = stop(app);
    await vi.advanceTimersByTimeAsync(101);
    expect((await stopping).status).toBe(409);
    expect(stopWriters).not.toHaveBeenCalled();
    release();
    await upload;
  });

  it('deduplicates concurrent stops and recovers if the host never sends SIGTERM', async () => {
    vi.useFakeTimers();
    const app = new Hono();
    const stopWriters = vi.fn();
    installVolumeStop(app, { hasVolumes: () => true, stopWriters, drain: async () => true });
    app.post('/write', c => c.text('done'));
    const responses = await Promise.all([stop(app), stop(app)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(stopWriters).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await app.request('/write', { method: 'POST' })).status).toBe(200);
  });
});
