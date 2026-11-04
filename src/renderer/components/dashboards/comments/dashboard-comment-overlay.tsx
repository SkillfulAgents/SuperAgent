import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CommentBox } from '@renderer/components/comments/comment-box'
import { DragHandle } from '@renderer/components/comments/drag-handle'
import { percentIn } from '@renderer/components/file-preview/comments/kinds/types'
import type { CommentPin } from './dashboard-comment-message'

interface DashboardCommentOverlayProps {
  /** Null: not pinned yet, so the comment is on the dashboard as a whole. */
  pin: CommentPin | null
  onPin: (pin: CommentPin) => void
  onSend: (text: string, dictated: boolean) => void
  onClose: () => void
  sending: boolean
  error: string | null
  /** Playing its way out. */
  closing: boolean
}

/** Where an unplaced pin waits. */
const CENTER: CommentPin = { x: 50, y: 50 }
/** Between the pin and the box, and between the box and the overlay's edges. */
const GAP = 22
const MARGIN = 12

/**
 * Comment mode over a dashboard: a glowing grid that takes every click, a pin
 * that marks the spot, and the comment box beside it. Clicking moves the pin
 * there (and the box with it); dragging moves the pin alone. The dashboard
 * under it is still, the way the screenshot caught it.
 */
export function DashboardCommentOverlay({ pin, onPin, onSend, onClose, sending, error, closing }: DashboardCommentOverlayProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const at = pin ?? CENTER

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const measure = () => setSize({ width: root.clientWidth, height: root.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // The box sits right of the pin, or left of it where the right has no room, and always inside.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (!box || !size.width) return
    const px = (at.x / 100) * size.width
    const py = (at.y / 100) * size.height
    const bw = box.offsetWidth
    const bh = box.offsetHeight
    let left = px + GAP
    if (left + bw > size.width - MARGIN) left = px - GAP - bw
    left = Math.min(Math.max(MARGIN, left), Math.max(MARGIN, size.width - MARGIN - bw))
    const top = Math.min(Math.max(MARGIN, py - 18), Math.max(MARGIN, size.height - MARGIN - bh))
    box.style.left = `${left}px`
    box.style.top = `${top}px`
  }, [at.x, at.y, size, error])

  // Escape from anywhere a field doesn't take it; the box's own field handles it there.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !sending) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose, sending])

  const pinAt = (clientX: number, clientY: number) => {
    const root = rootRef.current
    if (!root || sending) return
    onPin(percentIn(root.getBoundingClientRect(), clientX, clientY))
  }
  const onGrid = (e: React.SyntheticEvent) => !(e.target instanceof Element && e.target.closest('[data-comment-overlay]'))

  // Arrow keys nudge the pin from the grid (Shift for bigger steps); in the box they stay the field's.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 2
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
    if (!move || !onGrid(e) || sending) return
    e.preventDefault()
    const clamp = (v: number) => Math.min(100, Math.max(0, v))
    onPin({ x: clamp(at.x + move[0]), y: clamp(at.y + move[1]) })
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the grid is a pointing surface: click, right-click or arrow keys place the pin
    <div
      ref={rootRef}
      role="application"
      aria-label="Comment mode: click the dashboard to pin your comment to a spot"
      tabIndex={-1}
      data-testid="dashboard-comment-overlay"
      data-state={closing ? 'closed' : 'open'}
      className="dashboard-comment-overlay absolute inset-0 z-20 cursor-crosshair overflow-hidden select-none outline-none"
      onKeyDown={onKeyDown}
      // The field keeps focus through clicks on the grid, so typing carries on.
      onMouseDown={(e) => { if (onGrid(e)) e.preventDefault() }}
      onClick={(e) => { if (onGrid(e)) pinAt(e.clientX, e.clientY) }}
      // On the grid a right-click places the pin; in the box it stays the field's (spellcheck, paste).
      onContextMenu={(e) => {
        if (!onGrid(e)) return
        e.preventDefault()
        pinAt(e.clientX, e.clientY)
      }}
    >
      <div className="dashboard-comment-grid" aria-hidden />
      <div className="dashboard-comment-energy" aria-hidden>
        <div className="dashboard-comment-flow" />
        <div className="dashboard-comment-glimmer" />
      </div>
      <div className="dashboard-comment-scan" aria-hidden />
      <span className="dashboard-comment-corner left-3 top-3 border-l-2 border-t-2" aria-hidden />
      <span className="dashboard-comment-corner right-3 top-3 border-r-2 border-t-2" aria-hidden />
      <span className="dashboard-comment-corner bottom-3 left-3 border-b-2 border-l-2" aria-hidden />
      <span className="dashboard-comment-corner bottom-3 right-3 border-b-2 border-r-2" aria-hidden />

      <DragHandle
        x={at.x}
        y={at.y}
        onMove={pinAt}
        className="z-10 flex h-11 w-11 items-center justify-center"
      >
        <span className="dashboard-comment-reticle" data-placed={pin ? 'true' : 'false'} />
      </DragHandle>

      <div ref={boxRef} data-comment-overlay className="dashboard-comment-box absolute z-20 w-72 cursor-auto" style={{ left: MARGIN, top: MARGIN }}>
        <CommentBox
          variant="glow"
          label={pin ? 'Pinned to this spot · drag or click to move' : 'Whole dashboard · click to pin a spot'}
          placeholder="What should change?"
          submitLabel="Send"
          busy={sending}
          busyLabel="Sending…"
          error={error}
          autoFocus
          onCancel={onClose}
          onSubmit={(text, { dictated }) => onSend(text, dictated)}
        />
      </div>
    </div>
  )
}
