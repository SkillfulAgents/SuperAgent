import { useState, useRef, useEffect } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useFilePreview } from '@renderer/context/file-preview-context'
import type { TextSelectionInfo } from './use-text-selection'

interface CommentOverlayProps {
  selection: TextSelectionInfo
  filePath: string
  onClose: () => void
}

export function CommentOverlay({ selection, filePath, onClose }: CommentOverlayProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [commentText, setCommentText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { addComment } = useFilePreview()

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [isEditing])

  const handleAdd = () => {
    if (!commentText.trim()) return
    addComment({
      filePath,
      text: commentText.trim(),
      selectedText: selection.text || undefined,
      x: selection.x,
      y: selection.y,
    })
    setCommentText('')
    setIsEditing(false)
    onClose()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
      data-comment-overlay
      className="absolute z-30 w-64"
      style={{ left: Math.min(selection.rect.x, 200), top: selection.rect.y + 4 }}
    >
      <div className="rounded-lg border border-border bg-popover p-2 shadow-lg space-y-2">
        {selection.text && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5 line-clamp-2 italic">
            &ldquo;{selection.text}&rdquo;
          </div>
        )}
        {selection.x != null && selection.y != null && (
          <div className="text-xs text-muted-foreground bg-muted/50 rounded p-1.5">
            Point at ({Math.round(selection.x)}%, {Math.round(selection.y)}%)
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
