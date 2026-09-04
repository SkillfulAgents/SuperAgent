import type { ComponentType } from 'react'
import type { ApiMessage } from '@shared/lib/types/api'

export type UserMessageKind = 'system' | 'interrupt' | 'compact' | 'slash' | 'plain'

export interface UserMessageRenderProps {
  /** Bubble text after the structured blocks (sender, files, folders) are peeled. */
  text: string
  message: ApiMessage
}

/**
 * Everything the app knows about one kind of user message, in one place:
 * how to recognise it, whether the transcript shows it, and how to draw it.
 */
export interface UserMessageKindSpec {
  kind: UserMessageKind
  /**
   * Cheap check on the raw text. Runs in a memo over every loaded message, so
   * test a prefix before falling through to a regex.
   */
  match: (text: string) => boolean
  /** Hidden entries are dropped before windowing so they never consume a slot. */
  hidden: boolean
  /** Custom bubble body. Absent means the default Markdown rendering. */
  Render?: ComponentType<UserMessageRenderProps>
}
