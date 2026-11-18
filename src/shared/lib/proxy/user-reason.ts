const MAX_USER_REASON_LENGTH = 500

/**
 * What a person typed when turning down an agent's call, as it is forwarded:
 * trimmed, absent when blank, and bounded, since it lands in the proxy's error
 * body (and an MCP dismissal's audit row) and must not be an unbounded write
 * from the composer.
 */
export function cleanUserReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  return raw.trim().slice(0, MAX_USER_REASON_LENGTH)
}

/**
 * Append the person's own words to the agent-facing explanation. Kept here
 * so both proxies phrase it identically — the agent reads this as the reason a
 * tool call it made came back empty.
 */
export function withUserReason(message: string, reason?: string): string {
  return reason ? `${message} They said: "${reason}"` : message
}
