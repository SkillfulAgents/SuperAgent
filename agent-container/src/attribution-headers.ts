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

// Cap applied to the raw name before encoding, counted in code points so the
// cut can't split a surrogate pair (encodeURIComponent throws on lone halves).
const MAX_NAME_CODE_POINTS = 200;

/**
 * Return a copy of `env` with ANTHROPIC_CUSTOM_HEADERS extended with the agent
 * attribution headers, when the identity env vars are present. An existing
 * ANTHROPIC_CUSTOM_HEADERS value (user-configured) is preserved; the
 * attribution headers are appended after it.
 */
export function withAgentAttributionHeaders(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  const agentId = (env.SUPERAGENT_AGENT_ID ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '');
  if (!agentId) return env;

  const lines = [`${AGENT_ID_HEADER}: ${agentId}`];

  const rawName = (env.SUPERAGENT_AGENT_NAME ?? '').trim();
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

  const existing = env.ANTHROPIC_CUSTOM_HEADERS?.trim();
  return {
    ...env,
    ANTHROPIC_CUSTOM_HEADERS: existing ? `${existing}\n${lines.join('\n')}` : lines.join('\n'),
  };
}
