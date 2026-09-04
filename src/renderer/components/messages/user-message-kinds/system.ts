import { isSystemMessageText } from '@shared/lib/utils/system-message'
import type { UserMessageKindSpec } from './types'

/**
 * System-injected user turns (chat-integration notices, scheduler wake-ups,
 * MCP registration nudges). The person never typed them, so the transcript
 * hides them entirely.
 */
export const systemMessage: UserMessageKindSpec = {
  kind: 'system',
  match: isSystemMessageText,
  hidden: true,
}
