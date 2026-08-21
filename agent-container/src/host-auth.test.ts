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

  it('disables auth when no token was provided (older host)', async () => {
    const hostAuth = await loadHostAuth(undefined);

    expect(hostAuth.hostAuthEnabled()).toBe(false);
    expect(hostAuth.hostAuthHeaders()).toEqual({});
    expect(hostAuth.isValidHostToken(undefined)).toBe(true);
    expect(hostAuth.isValidHostToken('anything')).toBe(true);
  });
});
