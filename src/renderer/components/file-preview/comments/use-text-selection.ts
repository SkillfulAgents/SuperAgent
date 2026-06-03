import { useState, useEffect, useCallback, type RefObject } from 'react'

export interface TextSelectionInfo {
  text: string
  rect: DOMRect
  x?: number
  y?: number
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

    // Dismiss the overlay on any mousedown, unless the click is inside
    // the comment overlay itself (marked with data-comment-overlay).
    const handleDocumentMouseDown = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-comment-overlay]')) return
      setSelection(null)
    }

    container.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleDocumentMouseDown)
    return () => {
      container.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleDocumentMouseDown)
    }
  }, [containerRef])

  return { selection, clearSelection }
}
