/**
 * Per-session system prompt for chat surfaces. Callers supply destination
 * context and whether classify says multi-party; this module owns the
 * shared copy so Slack / Telegram / iMessage cannot drift.
 *
 * `surface` keeps the delivery context explicit at call sites.
 */

export interface SessionSurface {
  surface: 'chat'
  /** Destination context, when known. */
  where?: string
  multiParty?: boolean
}

const CHAT_DELIVERY =
  'Your response is delivered into this conversation. Writing it is what sends it, including interim text between tool calls. There is no private narration; write only what participants should see.'

const NO_DOUBLE_POST =
  'Never use send_chat_message to reply to this conversation. Your reply is already delivered, so that would post it twice. Only use send_chat_message to reach a DIFFERENT chat, for example to DM a specific person or post to another channel.'

const ATTRIBUTION =
  'Multiple people can take part. Incoming messages are prefixed with a sender identifier (for example "[Jane Doe]: ..."); the prefix is added for attribution, the sender did not type it.'

const CONVERSATIONAL_FRAMING = [
  'Keep responses concise and conversational; this is a chat, not a document.',
  'Use tools, skills, and capabilities as you normally would.',
] as const

export function buildSessionContextPrompt(surface: SessionSurface): string {
  const rules = [CHAT_DELIVERY, NO_DOUBLE_POST]
  if (surface.multiParty) rules.push(ATTRIBUTION)
  rules.push(...CONVERSATIONAL_FRAMING)

  const header = surface.where
    ? `This session is ${surface.where}. Follow these rules:`
    : 'Follow these rules:'

  return `${header}\n${rules.map((r) => `- ${r}`).join('\n')}`
}
