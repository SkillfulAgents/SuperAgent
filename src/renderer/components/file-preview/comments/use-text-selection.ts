import { useState, useEffect, useCallback, type RefObject } from 'react'
import type { CellRef } from '@renderer/context/file-preview-context'
import { useDismissOnOutsideClick } from './use-dismiss-on-outside-click'

export interface TextSelectionInfo {
  text: string
  rect: DOMRect
  x?: number
  y?: number
  cell?: CellRef
  /** Playback position in seconds, set for audio/video comments. */
  timestamp?: number
}

export function useTextSelection(containerRef: RefObject<HTMLElement | null>) {
  const [selection, setSelection] = useState<TextSelectionInfo | null>(null)

  const clearSelection = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const handleMouseUp = () => {
      requestAnimationFrame(() => {
        const sel = window.getSelection()
        if (!sel || sel.isCollapsed || !sel.rangeCount) return

        const range = sel.getRangeAt(0)
        const text = sel.toString().trim()
        if (!text) return

        if (!container.contains(range.commonAncestorContainer)) return

        const rects = range.getClientRects()
        if (rects.length === 0) return

        const containerRect = container.getBoundingClientRect()
        const lastRect = rects[rects.length - 1]

        setSelection({
          text,
          rect: new DOMRect(
            lastRect.right - containerRect.left,
            lastRect.bottom - containerRect.top,
            0,
            0
          ),
        })
      })
    }

    container.addEventListener('mouseup', handleMouseUp)
    return () => {
      container.removeEventListener('mouseup', handleMouseUp)
    }
  }, [containerRef])

  // Dismiss the pending comment affordance on any mousedown, unless the click
  // is inside the comment overlay itself (marked with data-comment-overlay).
  useDismissOnOutsideClick(selection != null, () => setSelection(null), DISMISS_IGNORE)

  return { selection, clearSelection }
}

const DISMISS_IGNORE = ['[data-comment-overlay]']
