import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { describeAnchor } from '@renderer/components/file-preview/comments/anchor'
import { PendingCommentsBar, type PendingComment } from '@renderer/components/file-preview/comments/comment-bar'
import { useCommentBox, type CommentStore } from '@renderer/components/file-preview/comments/use-comment-box'
import type { CommentSurface } from '@renderer/components/file-preview/comments/kinds'
import type { SelectionAt } from '@renderer/components/file-preview/comments/kinds/types'

/** Opens the reply box on text selected in an agent message. */
export type OpenReply = (at: SelectionAt) => void

const MessageReplyContext = createContext<OpenReply | null>(null)
export const MessageReplyProvider = MessageReplyContext.Provider

/** Null where replies are off (read-only threads). */
export function useOpenReply(): OpenReply | null {
  return useContext(MessageReplyContext)
}

export function formatReplies(replies: PendingComment[]): string {
  const lines: string[] = ['Replying to what you wrote:\n']
  replies.forEach((reply, i) => {
    // One line, so a multi-line quote stays inside its blockquote.
    lines.push(describeAnchor(reply.anchor).replace(/\s+/g, ' '))
    // A line right under a quote continues it in Markdown; the blank line keeps the reply out.
    lines.push('')
    lines.push(reply.text)
    if (i < replies.length - 1) lines.push('')
  })
  return lines.join('\n')
}

/**
 * The session thread as one more comment surface: replies to selected agent text use the
 * file drawer's comment box, opened from the message's context menu. `box` goes inside
 * `containerRef`, `bar` above the composer, `open` to `MessageReplyProvider`.
 */
export function useMessageReplies(
  containerRef: RefObject<HTMLElement | null>,
  sessionId: string | null,
  allowed: boolean,
): { box: ReactNode; bar: ReactNode; open: OpenReply | null } {
  const [replies, setReplies] = useState<PendingComment[]>([])
  const nextId = useRef(0)

  useEffect(() => setReplies([]), [sessionId])

  const store = useMemo<CommentStore>(() => ({
    enabled: allowed && sessionId != null,
    comments: replies,
    add: (anchor, text) => setReplies((prev) => [...prev, { id: `reply-${++nextId.current}`, anchor, text }]),
    noun: 'reply',
  }), [allowed, sessionId, replies])
  const surface = useMemo<CommentSurface>(() => ({ text: { blocks: containerRef } }), [containerRef])
  const { box, open: openAt, enabled } = useCommentBox(containerRef, surface, store, { gestures: false })
  const open = useMemo(() => (enabled ? (at: SelectionAt) => openAt(at) : null), [enabled, openAt])

  const remove = useCallback((id: string) => setReplies((prev) => prev.filter((reply) => reply.id !== id)), [])
  const clear = useCallback(() => setReplies([]), [])

  const bar = enabled && sessionId && (
    <PendingCommentsBar
      comments={replies}
      sessionId={sessionId}
      format={formatReplies}
      onRemove={remove}
      onClear={clear}
      noun="reply"
      className="mx-4 mb-2 overflow-hidden rounded-lg border border-border bg-background"
    />
  )
  return { box, bar, open }
}
