import { useCallback } from 'react'
import { MessageSquare, X, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { appendToSessionDraft, useDraftsStore } from '@renderer/context/drafts-context'
import { formatMediaTime } from './format-media-time'

interface CommentBarProps {
  comments: FileComment[]
  filePath: string
  sessionId: string
}

function getFilename(filePath: string): string {
  return filePath.split('/').pop() || filePath
}

/** Cap long cell values so a single comment can't bloat the prompt. */
function truncateValue(value: string, max = 200): string {
  return value.length > max ? value.slice(0, max) + '…' : value
}

/** Escape double quotes so a value containing `"` can't unbalance the wrapper. */
function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"')
}

export function formatComments(filePath: string, comments: FileComment[]): string {
  const filename = getFilename(filePath)
  const lines: string[] = [`File feedback on \`${filename}\`:\n`]

  comments.forEach((comment, i) => {
    if (comment.cell) {
      const { row, col, column, value } = comment.cell
      // Include the 1-based column position so duplicate header names stay
      // unambiguous, and escape the value so embedded quotes don't break out.
      const ref = `${row}:${column} (col ${col + 1}`
      if (value === undefined) {
        lines.push(`At cell ${ref}):`)
      } else if (value === '') {
        lines.push(`At cell ${ref}, empty cell):`)
      } else {
        lines.push(`At cell ${ref}, value: "${escapeQuotes(truncateValue(value))}"):`)
      }
      lines.push(comment.text)
    } else if (comment.selectedText) {
      lines.push(`> "${comment.selectedText}"`)
      lines.push(comment.text)
    } else if (comment.timestamp != null) {
      // Video comment: tie the feedback to the frame time and, when present, the
      // in-frame position the user marked.
      const pos = comment.x != null && comment.y != null
        ? ` at position (${Math.round(comment.x)}%, ${Math.round(comment.y)}%)`
        : ''
      lines.push(`At ${formatMediaTime(comment.timestamp)}${pos}:`)
      lines.push(comment.text)
    } else if (comment.x != null && comment.y != null) {
      lines.push(`At position (${Math.round(comment.x)}%, ${Math.round(comment.y)}%):`)
      lines.push(comment.text)
    } else {
      lines.push(comment.text)
    }
    if (i < comments.length - 1) lines.push('')
  })

  return lines.join('\n')
}

export function CommentBar({ comments, filePath, sessionId }: CommentBarProps) {
  const { clearComments, removeComment } = useFilePreview()
  const draftsStore = useDraftsStore()

  const handleSubmit = useCallback(() => {
    if (comments.length === 0) return
    const content = formatComments(filePath, comments)
    appendToSessionDraft(draftsStore, sessionId, content, { prepend: false })
    clearComments(filePath)
    queueMicrotask(() => {
      document.querySelector<HTMLElement>('[data-testid="message-input"]')?.focus()
    })
  }, [comments, filePath, sessionId, draftsStore, clearComments])

  if (comments.length === 0) return null

  return (
    <div className="shrink-0 border-t border-border/40 bg-muted/20">
      {/* Comment list */}
      <div className="max-h-32 overflow-y-auto px-3 py-2 space-y-1.5">
        {comments.map((comment, i) => (
          <div key={comment.id} className="flex items-start gap-2 text-xs group">
            <span className="text-muted-foreground shrink-0 tabular-nums">{i + 1}.</span>
            <div className="flex-1 min-w-0">
              {comment.cell && (
                <div className="text-muted-foreground/70 truncate">
                  <span className="font-medium">Cell {comment.cell.row}:{comment.cell.column}</span>
                  {comment.cell.value
                    ? <span className="italic"> &mdash; &ldquo;{comment.cell.value}&rdquo;</span>
                    : comment.cell.value === '' ? <span className="italic"> &mdash; empty</span> : null}
                </div>
              )}
              {comment.selectedText && (
                <div className="text-muted-foreground/70 italic truncate">&ldquo;{comment.selectedText}&rdquo;</div>
              )}
              {comment.timestamp != null && (
                <div className="text-muted-foreground/70">
                  At {formatMediaTime(comment.timestamp)}
                  {comment.x != null && comment.y != null && <span> &middot; ({Math.round(comment.x)}%, {Math.round(comment.y)}%)</span>}
                </div>
              )}
              {comment.timestamp == null && comment.x != null && comment.y != null && (
                <div className="text-muted-foreground/70">({Math.round(comment.x)}%, {Math.round(comment.y)}%)</div>
              )}
              <div className="text-foreground">{comment.text}</div>
            </div>
            <button
              onClick={() => removeComment(filePath, comment.id)}
              className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              title="Remove comment"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-border/30">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          <span>{comments.length} comment{comments.length === 1 ? '' : 's'}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => clearComments(filePath)}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={handleSubmit}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  )
}
