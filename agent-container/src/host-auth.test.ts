import { describe, it, expect, beforeEach, vi } from 'vitest';

// host-auth captures SUPERAGENT_HOST_TOKEN at module load and deletes it from
// process.env, so each test re-imports a fresh module instance.
async function loadHostAuth(token: string | undefined) {
  vi.resetModules();
  if (token === undefined) {
    delete process.env.SUPERAGENT_HOST_TOKEN;
  } else {
    process.env.SUPERAGENT_HOST_TOKEN = token;
  }
  return await import('./host-auth');
}

describe('host-auth', () => {
  beforeEach(() => {
    delete process.env.SUPERAGENT_HOST_TOKEN;
  });

  it('captures the token and strips it from process.env so children cannot inherit it', async () => {
    const hostAuth = await loadHostAuth('hostc_secret');

    expect(process.env.SUPERAGENT_HOST_TOKEN).toBeUndefined();
    expect(hostAuth.hostAuthEnabled()).toBe(true);
    expect(hostAuth.hostAuthHeaders()).toEqual({ 'x-superagent-host-token': 'hostc_secret' });
  });

  it('accepts only the exact token', async () => {
    const hostAuth = await loadHostAuth('hostc_secret');

    expect(hostAuth.isValidHostToken('hostc_secret')).toBe(true);
    expect(hostAuth.isValidHostToken('hostc_wrong')).toBe(false);
    expect(hostAuth.isValidHostToken('')).toBe(false);
    expect(hostAuth.isValidHostToken(undefined)).toBe(false);
  });

  // ELECTRON-DD: the host compares this id with the id of the token it is
  // sending to tell a stale container (restart it) from a real 401.
  it('exposes a one-way id of the token it was started with, never the token', async () => {
    const hostAuth = await loadHostAuth('hostc_secret');
    const id = hostAuth.hostTokenId();

    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]+$/);
    expect(id).not.toContain('hostc');
    expect('hostc_secret').not.toContain(id!);
    // Stable for the same token, different for another.
    expect(hostAuth.hostTokenId()).toBe(id);
    expect((await loadHostAuth('hostc_other')).hostTokenId()).not.toBe(id);
  });

  it('reports no token id when host auth is disabled', async () => {
    const hostAuth = await loadHostAuth(undefined);
    expect(hostAuth.hostTokenId()).toBeUndefined();
  });

  it('disables auth when no token was provided (older host)', async () => {
    const hostAuth = await loadHostAuth(undefined);

    expect(hostAuth.hostAuthEnabled()).toBe(false);
    expect(hostAuth.hostAuthHeaders()).toEqual({});
    expect(hostAuth.isValidHostToken(undefined)).toBe(true);
    expect(hostAuth.isValidHostToken('anything')).toBe(true);
  });
});
