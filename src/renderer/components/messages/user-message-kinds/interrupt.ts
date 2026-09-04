import type { UserMessageKindSpec } from './types'

/**
 * The synthetic "[Request interrupted by user]" / "[Request interrupted by
 * user for tool use]" user message the CLI appends when a turn is interrupted.
 * It ENDS the interrupted turn rather than starting a new one, so turn
 * scanning treats it specially. It renders as a plain bubble.
 */
export const interruptMarker: UserMessageKindSpec = {
  kind: 'interrupt',
  match: (text) => text.startsWith('[Request interrupted by user'),
  hidden: false,
}
