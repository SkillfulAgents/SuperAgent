/**
 * Agent attribution headers for LLM requests.
 *
 * The host injects the agent's identity as plain env vars (SUPERAGENT_AGENT_ID /
 * SUPERAGENT_AGENT_NAME) rather than a ready-made ANTHROPIC_CUSTOM_HEADERS value:
 * the container env travels via a Docker --env-file, whose format cannot carry the
 * newline that separates multiple `Name: Value` pairs. The headers are composed
 * here instead and handed to the Agent SDK, which forwards them on every request
 * to ANTHROPIC_BASE_URL (the platform proxy records them for per-agent usage).
 *
 * Header values must stay ASCII-safe — undici rejects non-Latin-1 header values,
 * which would fail every LLM request, so the display name is ALWAYS percent-encoded
 * (encodeURIComponent) and the consumer decodes unconditionally.
 */

const AGENT_ID_HEADER = 'X-Superagent-Agent-Id';
const AGENT_NAME_HEADER = 'X-Superagent-Agent-Name';

/** Env keys carrying the boot-time agent identity. Rejected by POST /env. */
export const AGENT_IDENTITY_ENV_KEYS = ['SUPERAGENT_AGENT_ID', 'SUPERAGENT_AGENT_NAME'] as const;

export function isAgentIdentityEnvKey(key: string): boolean {
  return (AGENT_IDENTITY_ENV_KEYS as readonly string[]).includes(key);
}

// The X-Superagent-Agent-* header namespace is reserved: any pre-existing line
// claiming it (e.g. a user-configured ANTHROPIC_CUSTOM_HEADERS) is dropped
// before the trusted values are appended. Matching is case-insensitive —
// header names are case-insensitive on the wire, so a lowercase forgery would
// otherwise survive as a separate object key and get merged into a combined
// `forged, real` value downstream.
const ATTRIBUTION_HEADER_LINE = /^\s*x-superagent-agent-(id|name)\s*:/i;

export interface AgentIdentity {
  id?: string;
  name?: string;
}

export function captureAgentIdentity(env: Record<string, string | undefined>): AgentIdentity {
  return { id: env.SUPERAGENT_AGENT_ID, name: env.SUPERAGENT_AGENT_NAME };
}

// Snapshotted at module load — i.e. at container-server boot, straight from the
// Docker-injected env — so the identity can't be rewritten later by per-session
// customEnvVars (spread over process.env in createQuery) or by the runtime
// POST /env endpoint. Headers are ONLY ever composed from this snapshot.
const BOOT_IDENTITY: AgentIdentity = captureAgentIdentity(process.env);

// Cap applied to the raw name before encoding, counted in code points so the
// cut can't split a surrogate pair (encodeURIComponent throws on lone halves).
const MAX_NAME_CODE_POINTS = 200;

/**
 * Return a copy of `env` with ANTHROPIC_CUSTOM_HEADERS extended with the agent
 * attribution headers composed from the boot-time identity snapshot. Any
 * pre-existing X-Superagent-Agent-* lines are stripped (case-insensitively) and
 * the identity env keys themselves are forced back to their boot values, so
 * neither user config nor runtime env mutation can spoof another agent.
 * Non-attribution user headers are preserved.
 */
export function withAgentAttributionHeaders(
  env: Record<string, string | undefined>,
  identity: AgentIdentity = BOOT_IDENTITY
): Record<string, string | undefined> {
  const out = { ...env };

  // Identity env keys always reflect boot state, never a later override.
  for (const key of AGENT_IDENTITY_ENV_KEYS) delete out[key];
  if (identity.id !== undefined) out.SUPERAGENT_AGENT_ID = identity.id;
  if (identity.name !== undefined) out.SUPERAGENT_AGENT_NAME = identity.name;

  const preserved = (env.ANTHROPIC_CUSTOM_HEADERS ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !ATTRIBUTION_HEADER_LINE.test(line));

  const agentId = (identity.id ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  const lines = [...preserved];
  if (agentId) {
    lines.push(`${AGENT_ID_HEADER}: ${agentId}`);
    const rawName = (identity.name ?? '').trim();
    if (rawName) {
      // Replace lone surrogates with U+FFFD (String.prototype.toWellFormed, hand
      // rolled — the tsconfig lib predates it): encodeURIComponent throws on
      // them, which would kill header composition entirely.
      const wellFormed = rawName.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        '�'
      );
      const capped = Array.from(wellFormed).slice(0, MAX_NAME_CODE_POINTS).join('');
      lines.push(`${AGENT_NAME_HEADER}: ${encodeURIComponent(capped)}`);
    }
  }

  if (lines.length > 0) {
    out.ANTHROPIC_CUSTOM_HEADERS = lines.join('\n');
  } else {
    delete out.ANTHROPIC_CUSTOM_HEADERS;
  }
  return out;
}
