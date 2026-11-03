import { useRef, useLayoutEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { CommentBox } from '@renderer/components/comments/comment-box'
import { describeAnchor } from './anchor'
import type { CommentAnchor } from './kinds'

interface CommentOverlayProps {
  anchor: CommentAnchor
  /** Where the box opens, in its positioned parent's coordinates. */
  rect: DOMRect
  /** Gets the trimmed text of an added comment. */
  onAdd: (text: string) => void
  onClose: () => void
  /** What the box calls the note. */
  noun?: 'comment' | 'reply'
  /** The editor. Otherwise a "Comment" chip, which calls `onEdit`. */
  autoEdit?: boolean
  /** Start the mic as the editor opens, when voice input is set up. */
  autoListen?: boolean
  /** The "Comment" chip was clicked. */
  onEdit?: () => void
}

export function CommentOverlay({ anchor, rect, onAdd, onClose, onEdit, noun = 'comment', autoEdit = false, autoListen = false }: CommentOverlayProps) {

  // Slide the overlay left, before it paints, so it ends 8px inside the pane that clips it.
  // Re-runs when the editor opens or its anchor moves.
  const overlayRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const overlay = overlayRef.current
    let pane = overlay?.parentElement
    while (pane && getComputedStyle(pane).overflowX === 'visible') pane = pane.parentElement
    if (!overlay || !pane) return
    overlay.style.marginLeft = ''
    const right = pane.getBoundingClientRect().left + pane.clientWidth - 8
    overlay.style.marginLeft = `${Math.min(0, right - overlay.getBoundingClientRect().right)}px`
  }, [autoEdit, rect.x])

  if (!autoEdit) {
    return (
      <div
        ref={overlayRef}
        data-comment-overlay
        className="absolute z-30"
        style={{ left: rect.x, top: rect.y + 4 }}
      >
        <button
          onClick={onEdit}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-primary text-primary-foreground shadow-md hover:bg-primary/90 transition-colors"
        >
          <MessageSquarePlus className="h-3 w-3" />
          Comment
        </button>
      </div>
    )
  }

  return (
    <div
      ref={overlayRef}
      data-comment-overlay
      className="absolute z-30 w-64"
      style={{ left: rect.x, top: rect.y + 4 }}
    >
      <CommentBox
        label={describeAnchor(anchor)}
        autoFocus
        autoListen={autoListen}
        placeholder={`Add your ${noun}...`}
        onCancel={onClose}
        onSubmit={(text) => {
          onAdd(text)
          onClose()
        }}
      />
    </div>
  )
}
