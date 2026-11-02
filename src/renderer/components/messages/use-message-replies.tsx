import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { CommentOverlayView } from '@renderer/components/file-preview/comments/comment-overlay'
import { CommentBarView, submitToComposer } from '@renderer/components/file-preview/comments/comment-bar'
import { quoted } from '@renderer/components/file-preview/comments/kinds/types'

/** An agent message bubble: text selected in it can be replied to. */
const AGENT_TEXT = '[data-agent-reply]'
const OWN_UI = '[data-comment-overlay]'

export interface MessageReply {
  id: string
  quote: string
  text: string
}

interface Pending {
  quote: string
  /** Where the box opens, in the container's coordinates. */
  rect: DOMRect
  /** A "Reply" chip until clicked, so copying is not interrupted. */
  chip: boolean
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

/** Text selected inside one agent message in `container`. */
function agentSelectionIn(container: HTMLElement | null): { quote: string; range: Range } | null {
  const selection = window.getSelection()
  if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  const node = range.commonAncestorContainer
  const el = node instanceof Element ? node : node.parentElement
  const quote = selection.toString().trim()
  if (!el || !container.contains(el) || !el.closest(AGENT_TEXT) || el.closest(OWN_UI) || !quote) return null
  return { quote, range }
}

/**
 * Replies to text selected in agent messages, as file-preview comments work: selecting
 * shows a "Reply" chip, the chip opens the box, and added replies wait in a bar until
 * Submit puts them into the composer draft. `box` goes inside `containerRef`.
 */
export function useMessageReplies(
  containerRef: RefObject<HTMLElement | null>,
  sessionId: string | null,
  enabled: boolean,
): { box: ReactNode; bar: ReactNode } {
  const draftsStore = useDraftsStore()
  const [replies, setReplies] = useState<MessageReply[]>([])
  const [pending, setPending] = useState<Pending | null>(null)
  const nextId = useRef(0)
  const pressedInThread = useRef(false)
  const latest = useRef(pending)
  // Layout, not passive: a press right after the chip paints must already see it.
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
    if (agentSelectionIn(containerRef.current)) window.getSelection()?.removeAllRanges()
  }, [containerRef])

  useEffect(() => {
    if (!enabled || !sessionId) return
    const inThread = (target: EventTarget | null): target is Element =>
      target instanceof Element && !!containerRef.current?.contains(target)

    // The chip closes on any outside press, as a selection does. An open box never does.
    const onMouseDown = (e: MouseEvent) => {
      pressedInThread.current = e.button === 0 && inThread(e.target) && !e.target.closest(`button, a, ${OWN_UI}`)
      if (latest.current?.chip && !(e.target instanceof Element && e.target.closest(OWN_UI))) setPending(null)
    }
    // After the browser settles the selection, so a click that clears it reads as cleared.
    const onMouseUp = () => requestAnimationFrame(() => {
      if (latest.current || !pressedInThread.current) return
      const container = containerRef.current
      const selected = agentSelectionIn(container)
      const rects = selected?.range.getClientRects()
      const last = rects?.[rects.length - 1]
      if (!container || !selected || !last) return
      const at = container.getBoundingClientRect()
      setPending({ quote: selected.quote, rect: new DOMRect(last.right - at.left, last.bottom - at.top), chip: true })
    })
    const onKeyDown = (e: KeyboardEvent) => {
      const open = latest.current
      if (e.key !== 'Escape' || !open || e.defaultPrevented || isTyping(e.target)) return
      // A chip leaves the selection for copying.
      if (open.chip) setPending(null)
      else close()
    }
    // The chip sits where the selection was; scrolling moves the text away from it.
    const onScroll = () => {
      if (latest.current?.chip) setPending(null)
    }
    const container = containerRef.current
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('keydown', onKeyDown)
    container?.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      container?.removeEventListener('scroll', onScroll, true)
    }
  }, [enabled, sessionId, containerRef, close])

  const handleSubmit = useCallback(() => {
    if (!sessionId || replies.length === 0) return
    submitToComposer(draftsStore, sessionId, formatReplies(replies))
    setReplies([])
  }, [draftsStore, sessionId, replies])

  if (!enabled || !sessionId) return { box: null, bar: null }

  const box = pending && (
    <CommentOverlayView
      key={pending.chip ? 'chip' : 'box'}
      noun="reply"
      label={describeQuote(pending.quote)}
      rect={pending.rect}
      autoEdit={!pending.chip}
      onEdit={() => setPending({ ...pending, chip: false })}
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
  return { box, bar }
}
