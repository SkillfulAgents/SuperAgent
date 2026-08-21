import * as dns from 'dns';
import * as net from 'net';

/**
 * Resolve the address the container should use to reach the host's CDP proxy,
 * derived from HOST_APP_URL - the same host address the launch-host-browser
 * request already reached the host at.
 *
 * Chrome's CDP server validates the Host header and rejects hostnames, so this
 * always returns an IPv4 address. When HOST_APP_URL is already an IP (Apple
 * Container, whose containers can't resolve host.docker.internal - no --add-host
 * equivalent - so its host address is the gateway IP), it is used directly with
 * no DNS. When it is a hostname (host.docker.internal on Docker/Lima/WSL2, which
 * those runtimes map to an IPv4), it is resolved via DNS, pinned to IPv4 so the
 * result is always usable in a host:port authority.
 *
 * `lookup` is injectable for tests; it defaults to DNS.
 */
export async function resolveCdpIp(
  hostAppUrl: string,
  lookup: (hostname: string) => Promise<string> = async (hostname) =>
    (await dns.promises.lookup(hostname, { family: 4 })).address,
): Promise<string> {
  let hostname: string;
  try {
    hostname = new URL(hostAppUrl).hostname;
  } catch {
    throw new Error(`Invalid HOST_APP_URL: ${hostAppUrl}`);
  }
  if (net.isIP(hostname) !== 0) return hostname;
  try {
    return await lookup(hostname);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to resolve ${hostname} (${cause})`);
  }
}
