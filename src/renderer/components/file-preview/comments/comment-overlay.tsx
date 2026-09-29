import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { isComposing, isSubmitEnter } from '@renderer/lib/enter-key'
import type { TextSelectionInfo } from './use-text-selection'
import { formatCommentTime } from './format-media-time'

interface CommentOverlayProps {
  selection: TextSelectionInfo
  filePath: string
  agentSlug: string
  onClose: () => void
  /** Skip the intermediate "Comment" button and open the editor immediately. */
  autoEdit?: boolean
}

export function CommentOverlay({ selection, filePath, agentSlug, onClose, autoEdit = false }: CommentOverlayProps) {
  const [isEditing, setIsEditing] = useState(autoEdit)
  const [commentText, setCommentText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { addComment } = useFilePreview()

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isEditing])

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
  }, [isEditing, selection.rect.x])

  const handleAdd = () => {
    if (!commentText.trim()) return
    addComment({
      filePath,
      agentSlug,
      text: commentText.trim(),
      selectedText: selection.text || undefined,
      x: selection.x,
      y: selection.y,
      cell: selection.cell,
      timestamp: selection.timestamp,
    })
    setCommentText('')
    setIsEditing(false)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e.nativeEvent)) return
    if (isSubmitEnter(e.nativeEvent)) {
      e.preventDefault()
      handleAdd()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  if (!isEditing) {
    return (
      <div
        ref={overlayRef}
        data-comment-overlay
        className="absolute z-30"
        style={{ left: selection.rect.x, top: selection.rect.y + 4 }}
      >
        <button
          onClick={() => setIsEditing(true)}
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
      style={{ left: selection.rect.x, top: selection.rect.y + 4 }}
    >
      <div className="rounded-lg border border-border bg-popover p-2 shadow-lg space-y-2">
        {selection.text && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5 line-clamp-2 italic">
            &ldquo;{selection.text}&rdquo;
          </div>
        )}
        {selection.timestamp != null && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5">
            At {formatCommentTime(selection.timestamp)}
            {selection.x != null && selection.y != null && (
              <span> &middot; ({Math.round(selection.x)}%, {Math.round(selection.y)}%)</span>
            )}
          </div>
        )}
        {selection.timestamp == null && selection.x != null && selection.y != null && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5">
            Point at ({Math.round(selection.x)}%, {Math.round(selection.y)}%)
          </div>
        )}
        {selection.cell && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5">
            <span className="font-medium">Cell {selection.cell.row}:{selection.cell.column}</span>
            {selection.cell.value
              ? <span className="italic"> &mdash; &ldquo;{selection.cell.value}&rdquo;</span>
              : selection.cell.value === '' ? <span className="italic"> &mdash; empty cell</span> : null}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={commentText}
          onChange={(e) => setCommentText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add your comment..."
          className="w-full text-xs rounded border border-border bg-background p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          rows={3}
        />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-6 text-xs"
            onClick={handleAdd}
            disabled={!commentText.trim()}
          >
            Add
          </Button>
        </div>
      </div>
    </div>
  )
}
