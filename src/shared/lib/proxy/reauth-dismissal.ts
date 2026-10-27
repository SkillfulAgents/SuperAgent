/**
 * Append the dismisser's own words to the agent-facing explanation. Kept here
 * so both proxies phrase it identically — the agent reads this as the reason a
 * tool call it made came back empty.
 */
export function withDismissalReason(message: string, reason?: string): string {
  return reason ? `${message} They said: "${reason}"` : message
}
