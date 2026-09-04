import { compactCommand } from './compact'
import { interruptMarker } from './interrupt'
import { slashCommand } from './slash-command'
import { systemMessage } from './system'
import type { UserMessageKindSpec } from './types'

export type { UserMessageKind, UserMessageKindSpec, UserMessageRenderProps } from './types'

/** Default: a Markdown bubble, always shown. */
export const plainMessage: UserMessageKindSpec = {
  kind: 'plain',
  match: () => true,
  hidden: false,
}

/**
 * Registry of user-message kinds, first match wins. Order is deliberate:
 * hidden kinds first, then exact prefixes, then the broad "/" catch-all.
 * Adding a kind is one spec file plus one entry here.
 */
export const USER_MESSAGE_KINDS: readonly UserMessageKindSpec[] = [
  systemMessage,
  interruptMarker,
  compactCommand,
  slashCommand,
]

/** Classify raw message text. Returns the shared spec object, no allocation. */
export function classifyUserText(text: string): UserMessageKindSpec {
  return USER_MESSAGE_KINDS.find((spec) => spec.match(text)) ?? plainMessage
}

/** Classify a transcript entry. Non-user entries and non-text content are plain. */
export function classifyUserMessage(m: {
  type: string
  content?: { text?: string } | string | null
}): UserMessageKindSpec {
  if (m.type !== 'user' || typeof m.content !== 'object' || !m.content) return plainMessage
  return classifyUserText(m.content.text ?? '')
}
