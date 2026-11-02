import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { CommentOverlayView } from '@renderer/components/file-preview/comments/comment-overlay'
import { CommentBarView, submitToComposer } from '@renderer/components/file-preview/comments/comment-bar'
import { quoted } from '@renderer/components/file-preview/comments/kinds/types'

export interface MessageReply {
  id: string
  quote: string
  text: string
}

/** Text selected inside one message. */
export interface ReplySelection {
  quote: string
  range: Range
}

/** What a message's context menu needs to offer Reply. */
export interface MessageReplyAction {
  /** The selection inside `bubble`, if any. */
  selectionIn: (bubble: Element) => ReplySelection | null
  /** Opens the reply box on `selection`. */
  open: (selection: ReplySelection) => void
}

const MessageReplyContext = createContext<MessageReplyAction | null>(null)
export const MessageReplyProvider = MessageReplyContext.Provider

/** Null where replies are off (read-only threads). */
export function useMessageReplyAction(): MessageReplyAction | null {
  return useContext(MessageReplyContext)
}

interface Pending {
  quote: string
  /** Where the box opens, in the container's coordinates. */
  rect: DOMRect
}

/** The quote as one line, so it stays inside its blockquote. */
function describeQuote(quote: string): string {
  return `> ${quoted(quote.replace(/\s+/g, ' ').trim())}`
}

export function formatReplies(replies: MessageReply[]): string {
  const lines: string[] = ['Replying to what you wrote:\n']
  replies.forEach((reply, i) => {
    lines.push(describeQuote(reply.quote))
    // A line right under a quote continues it in Markdown; the blank line keeps the reply out.
    lines.push('')
    lines.push(reply.text)
    if (i < replies.length - 1) lines.push('')
  })
  return lines.join('\n')
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
}

function selectionIn(root: Element | null): ReplySelection | null {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer
  const el = node instanceof Element ? node : node.parentElement
  const quote = selection.toString().trim()
  return el && root.contains(el) && quote ? { quote, range } : null
}

/**
 * Replies to text selected in agent messages, as file-preview comments work: Reply in the
 * message's context menu opens the box, and added replies wait in a bar until Submit puts
 * them into the composer draft. `box` goes inside `containerRef`; `action` goes to
 * `MessageReplyProvider` around the messages.
 */
export function useMessageReplies(
  containerRef: RefObject<HTMLElement | null>,
  sessionId: string | null,
  enabled: boolean,
): { box: ReactNode; bar: ReactNode; action: MessageReplyAction | null } {
  const draftsStore = useDraftsStore()
  const [replies, setReplies] = useState<MessageReply[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const nextId = useRef(0)
  const latest = useRef(pending)
  useLayoutEffect(() => { latest.current = pending })

  useEffect(() => {
    setReplies([])
    setPending(null)
  }, [sessionId])

  useEffect(() => {
    if (!enabled) setPending(null)
  }, [enabled])

  /** Closing drops the selection it was opened on. */
  const close = useCallback(() => {
    setPending(null)
    if (selectionIn(containerRef.current)) window.getSelection()?.removeAllRanges()
  }, [containerRef])

  // Escape closes the box from anywhere a field does not own the key. The box's own field handles it there.
  useEffect(() => {
    if (!pending) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && latest.current && !e.defaultPrevented && !isTyping(e.target)) close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending, close])

  const action = useMemo<MessageReplyAction | null>(() => (!enabled || !sessionId ? null : {
    selectionIn,
    open: ({ quote, range }) => {
      const container = containerRef.current
      if (!container) return
      const rects = range.getClientRects()
      const last = rects[rects.length - 1] ?? range.getBoundingClientRect()
      const at = container.getBoundingClientRect()
      setPending({ quote, rect: new DOMRect(last.right - at.left, last.bottom - at.top) })
    },
  }), [enabled, sessionId, containerRef])

  const handleSubmit = useCallback(() => {
    if (!sessionId || replies.length === 0) return
    submitToComposer(draftsStore, sessionId, formatReplies(replies))
    setReplies([])
  }, [draftsStore, sessionId, replies])

  if (!action) return { box: null, bar: null, action }

  const box = pending && (
    <CommentOverlayView
      noun="reply"
      label={describeQuote(pending.quote)}
      rect={pending.rect}
      autoEdit
      onAdd={(text) => setReplies((prev) => [...prev, { id: `reply-${++nextId.current}`, quote: pending.quote, text }])}
      onClose={close}
    />
  )
  const bar = (
    <CommentBarView
      noun="reply"
      className="mx-4 mb-2 overflow-hidden rounded-lg border border-border bg-background"
      items={replies.map((reply) => ({ id: reply.id, label: describeQuote(reply.quote), text: reply.text }))}
      onRemove={(id) => setReplies((prev) => prev.filter((reply) => reply.id !== id))}
      onCancel={() => setReplies([])}
      onSubmit={handleSubmit}
    />
  )
  return { box, bar, action }
}
