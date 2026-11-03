import { useRef, type ReactNode } from 'react'
import { cn } from '@shared/lib/utils/cn'

interface DragHandleProps {
  /** Where the handle's centre sits, in percent of its positioned parent. */
  x: number
  y: number
  /** The pointer moved while the handle was held, in viewport pixels. */
  onMove: (clientX: number, clientY: number) => void
  className?: string
  children?: ReactNode
}

/**
 * The open comment's point, held and dragged: the video frame's marker and the
 * dashboard's pin. The pointer is captured, so a fast drag that leaves the
 * handle keeps moving it.
 */
export function DragHandle({ x, y, onMove, className, children }: DragHandleProps) {
  const dragging = useRef(false)
  return (
    <div
      data-comment-marker
      role="presentation"
      onPointerDown={e => { e.preventDefault(); dragging.current = true; e.currentTarget.setPointerCapture(e.pointerId) }}
      onPointerMove={e => { if (dragging.current) onMove(e.clientX, e.clientY) }}
      onPointerUp={e => { dragging.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId) }}
      // A drag ends in a click on the handle; it must not reach the surface under it.
      onClick={e => e.stopPropagation()}
      className={cn('absolute -translate-x-1/2 -translate-y-1/2 cursor-move touch-none', className)}
      style={{ left: `${x}%`, top: `${y}%` }}
      title="Drag to position the comment"
    >
      {children}
    </div>
  )
}
