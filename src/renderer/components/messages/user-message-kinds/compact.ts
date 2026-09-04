import { SlashCommandBubble } from './slash-command'
import type { UserMessageKindSpec } from './types'

const COMPACT_COMMAND = /^\/compact(?:\s|$)/

/**
 * A manual "/compact" command. Its own kind because the list pairs a pending
 * "/compact" with the compact_boundary entry it produces instead of a user
 * message, and never restores it to the draft. Draws like any slash command.
 */
export const compactCommand: UserMessageKindSpec = {
  kind: 'compact',
  match: (text) => {
    const trimmed = text.trimStart()
    return trimmed.startsWith('/compact') && COMPACT_COMMAND.test(trimmed)
  },
  hidden: false,
  Render: SlashCommandBubble,
}
