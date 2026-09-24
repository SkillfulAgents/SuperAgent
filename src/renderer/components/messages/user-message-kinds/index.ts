import { integrationMessage } from './integration'
import { connectionReplacementNotice } from './connection-replacement'
import { compactCommand } from './compact'
import { interruptMarker } from './interrupt'
import { slashCommand } from './slash-command'
import { systemMessage } from './system'
import { voiceModeNotice } from './voice-mode'
import type { UserMessageKindSpec } from './types'
import type { ApiMessage } from '@shared/lib/types/api'

export type { UserMessageKind, UserMessageKindSpec, UserMessageRenderProps } from './types'

/** Default: a Markdown bubble, always shown. */
export const plainMessage: UserMessageKindSpec = {
  kind: 'plain',
  match: () => true,
  hidden: false,
}

/**
 * Registry of user-message kinds, first match wins. Metadata kinds are tried
 * before any text. Among text kinds the order is deliberate: visible system
 * notices first, then the hidden system prefix, then exact prefixes, then the
 * broad "/" catch-all. Adding a kind is one spec file plus one entry here.
 */
export const USER_MESSAGE_KINDS: readonly UserMessageKindSpec[] = [
  integrationMessage,
  voiceModeNotice,
  connectionReplacementNotice,
  systemMessage,
  interruptMarker,
  compactCommand,
  slashCommand,
]

/** Classify raw message text. Returns the shared spec object, no allocation. */
export function classifyUserText(text: string): UserMessageKindSpec {
  return USER_MESSAGE_KINDS.find((spec) => spec.match(text)) ?? plainMessage
}

/**
 * Classify a transcript entry: host metadata first, then the text. `text`
 * overrides the content text when the caller already peeled it (the bubble
 * classifies after lifting sender, files and folders). Non-user entries and
 * non-text content are plain.
 */
export function classifyUserMessage(m: {
  type: string
  content?: { text?: string } | string | null
  integration?: ApiMessage['integration']
}, text?: string): UserMessageKindSpec {
  if (m.type !== 'user') return plainMessage
  const byMetadata = USER_MESSAGE_KINDS.find((spec) => spec.matchMessage?.(m))
  if (byMetadata) return byMetadata
  if (text !== undefined) return classifyUserText(text)
  if (typeof m.content !== 'object' || !m.content) return plainMessage
  return classifyUserText(m.content.text ?? '')
}
