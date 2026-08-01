/**
 * Framing for cross-agent invocation prompts delivered into an EXISTING
 * session. The prefix does two jobs: the target model (and the session's
 * user, in the timeline) sees who is speaking — it is not the session's own
 * user — and autopilot intent extraction can exclude agent-authored traffic
 * from "what the user typed" (extractUserPrompts filters on this prefix).
 * New sessions created by an invoke are not framed: the whole session is
 * premised on the caller's prompt and carries invokedByAgentSlug metadata.
 */
export const X_AGENT_MESSAGE_PREFIX = '[Message from agent '

export function formatXAgentMessage(callerName: string, prompt: string): string {
  return `${X_AGENT_MESSAGE_PREFIX}"${callerName}"]\n\n${prompt}`
}
