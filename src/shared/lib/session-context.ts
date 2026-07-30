/**
 * Per-session delivery orientation. Callers supply the session surface; this
 * module owns the shared copy so origins cannot drift.
 *
 * `surface` keeps the delivery context explicit at call sites.
 */

export type SessionSurface =
  | { surface: 'chat'; where?: string; multiParty?: boolean }
  | { surface: 'app' }
  | { surface: 'automation'; kind: 'scheduled-task' | 'webhook-trigger' }
  | { surface: 'agent-call' }

const APP_DELIVERY =
  'This session is a conversation in the app. Your response is delivered into it — writing it is what sends it, and no tool is needed for that.'

const AUTOMATION_DELIVERY =
  'Your response goes to the session transcript, and writing it does not reach anyone. If you need to tell a person or agent something, that takes a tool.'

const AGENT_CALL_DELIVERY =
  "Your response is recorded in this session's transcript. Writing it is what records it, and no tool is needed. Put the answer in your final message rather than in interim narration."

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

function buildChatPrompt(surface: Extract<SessionSurface, { surface: 'chat' }>): string {
  const rules = [CHAT_DELIVERY, NO_DOUBLE_POST]
  if (surface.multiParty) rules.push(ATTRIBUTION)
  rules.push(...CONVERSATIONAL_FRAMING)

  const header = surface.where
    ? `This session is ${surface.where}. Follow these rules:`
    : 'Follow these rules:'

  return `${header}\n${rules.map((r) => `- ${r}`).join('\n')}`
}

export function buildSessionContextPrompt(surface: SessionSurface): string {
  switch (surface.surface) {
    case 'app':
      return APP_DELIVERY
    case 'automation': {
      const origin =
        surface.kind === 'scheduled-task'
          ? 'a scheduled task'
          : 'a webhook trigger'
      return `This session was started by ${origin}, not by a person in a conversation. ${AUTOMATION_DELIVERY}`
    }
    case 'agent-call':
      return `This session was started by another agent. ${AGENT_CALL_DELIVERY}`
    case 'chat':
      return buildChatPrompt(surface)
  }
}
