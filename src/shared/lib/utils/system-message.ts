/**
 * Prefix for system-injected user messages: entries the app or the container
 * writes into the transcript as `user` turns (chat-integration notices,
 * scheduler wake-ups, MCP registration nudges) that the person never typed.
 * The UI hides them and notification summaries skip them.
 *
 * The container keeps its own copy of this constant because it is a separate
 * package. Keep in sync with SYSTEM_MESSAGE_PREFIX in agent-container/src/claude-code.ts.
 */
export const SYSTEM_MESSAGE_PREFIX = '[SYSTEM] '

/** True when `text` is a system-injected user message. Exact prefix, no trimming. */
export function isSystemMessageText(text: string): boolean {
  return text.startsWith(SYSTEM_MESSAGE_PREFIX)
}
