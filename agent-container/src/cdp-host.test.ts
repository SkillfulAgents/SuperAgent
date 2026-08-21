import { describe, it, expect, vi } from 'vitest';
import { resolveCdpIp } from './cdp-host';

describe('resolveCdpIp', () => {
  // Apple Container: HOST_APP_URL is the host gateway IP because containers
  // there can't resolve host.docker.internal (no --add-host equivalent). The
  // old code always DNS-resolved the hardcoded name and failed NXDOMAIN here.
  it('uses an IP HOST_APP_URL directly, without DNS', async () => {
    const lookup = vi.fn();
    const ip = await resolveCdpIp('http://192.168.64.1:47891', lookup);
    expect(ip).toBe('192.168.64.1');
    expect(lookup).not.toHaveBeenCalled();
  });

  // Docker/Lima/WSL2: HOST_APP_URL is host.docker.internal, which those
  // runtimes map (Docker Desktop forwarder, or --add-host). Resolve to an IP so
  // Chrome's CDP Host-header check (which rejects hostnames) passes.
  it('resolves a hostname HOST_APP_URL via DNS', async () => {
    const lookup = vi.fn().mockResolvedValue('10.4.0.2');
    const ip = await resolveCdpIp('http://host.docker.internal:47891', lookup);
    expect(lookup).toHaveBeenCalledWith('host.docker.internal');
    expect(ip).toBe('10.4.0.2');
  });

  it('throws "Failed to resolve <name>" with the DNS cause when lookup fails', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      resolveCdpIp('http://host.docker.internal:47891', lookup),
    ).rejects.toThrow('Failed to resolve host.docker.internal (ENOTFOUND)');
  });
});
