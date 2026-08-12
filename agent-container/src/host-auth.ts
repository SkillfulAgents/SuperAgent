import crypto from 'crypto';

/**
 * Host→container API authentication.
 *
 * The container API is reachable from inside the container (the agent's Bash
 * shares the network namespace), so anything policy-bearing — session creation,
 * message sends with capabilityPolicies, input resolve/reject — must prove it
 * came from the host. The host passes a per-agent secret via the
 * SUPERAGENT_HOST_TOKEN env var; we capture it at module load and delete it
 * from process.env so no child process (the Claude CLI and every Bash/tool it
 * spawns — they inherit `...process.env`) ever sees it.
 *
 * Residual exposure: the boot-time environment stays readable at
 * /proc/1/environ for same-uid processes, so this raises the bar rather than
 * providing hard isolation. Hard isolation needs a uid split between the
 * server and the CLI.
 *
 * When the env var is absent (older host, dev setups), auth is disabled and
 * the API behaves as before.
 */
const HOST_API_TOKEN: string | undefined = process.env.SUPERAGENT_HOST_TOKEN || undefined;
delete process.env.SUPERAGENT_HOST_TOKEN;

export const HOST_TOKEN_HEADER = 'x-superagent-host-token';

export function hostAuthEnabled(): boolean {
  return HOST_API_TOKEN !== undefined;
}

/** Headers for in-process code that calls the container's own API (e.g. browser tools). */
export function hostAuthHeaders(): Record<string, string> {
  return HOST_API_TOKEN ? { [HOST_TOKEN_HEADER]: HOST_API_TOKEN } : {};
}

/**
 * Non-secret, one-way id of the host token this container was started with
 * ("key id"), or undefined when host auth is disabled.
 *
 * Served on the unauthenticated /health so the host can tell a stale-token 401
 * (container still holding a token the host has since rotated — it must be
 * restarted) apart from a genuinely unauthorized caller, without either side
 * exchanging token material. A truncated SHA-256 of a 32-byte random secret is
 * not reversible, and the agent can already read its own boot environment.
 */
export function hostTokenId(): string | undefined {
  if (!HOST_API_TOKEN) return undefined;
  return crypto.createHash('sha256').update(HOST_API_TOKEN).digest('hex').slice(0, 16);
}

export function isValidHostToken(presented: string | undefined): boolean {
  if (!HOST_API_TOKEN) return true;
  if (!presented) return false;
  // Hash both sides so timingSafeEqual gets equal-length buffers.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(HOST_API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}
