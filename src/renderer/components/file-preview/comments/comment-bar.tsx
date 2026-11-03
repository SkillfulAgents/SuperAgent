import { useCallback } from 'react'
import { MessageSquare, X, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { appendToSessionDraft, useDraftsStore } from '@renderer/context/drafts-context'
import { focusSessionComposer } from '@renderer/components/messages/composer-focus'
import { describeAnchor } from './anchor'
import { getPathName } from '@shared/lib/utils/workspace-path'
import { cn } from '@shared/lib/utils/cn'
import type { CommentAnchor } from './kinds'

interface CommentBarProps {
  comments: FileComment[]
  filePath: string
  agentSlug: string
  sessionId: string
}

export function formatComments(filePath: string, comments: FileComment[]): string {
  const filename = getPathName(filePath)
  const lines: string[] = [`File feedback on \`${filename}\`:\n`]

  comments.forEach((comment, i) => {
    lines.push(describeAnchor(comment.anchor))
    lines.push(comment.text)
    if (i < comments.length - 1) lines.push('')
  })

  return lines.join('\n')
}

export function CommentBar({ comments, filePath, agentSlug, sessionId }: CommentBarProps) {
  const { clearComments, removeComment, commentsEnabled } = useFilePreview()
  const format = useCallback((added: FileComment[]) => formatComments(filePath, added), [filePath])
  if (!commentsEnabled) return null
  return (
    <PendingCommentsBar
      comments={comments}
      sessionId={sessionId}
      format={format}
      onRemove={(id) => removeComment(filePath, agentSlug, id)}
      onClear={() => clearComments(filePath, agentSlug)}
      className="border-t border-border/40"
    />
  )
}

export interface PendingComment {
  id: string
  anchor: CommentAnchor
  text: string
}

interface PendingCommentsBarProps<C extends PendingComment> {
  comments: C[]
  sessionId: string
  /** The draft text the comments become on Submit. */
  format: (comments: C[]) => string
  onRemove: (id: string) => void
  onClear: () => void
  className?: string
}

/** Added comments waiting for Submit, which puts them into the session's composer draft without sending. */
export function PendingCommentsBar<C extends PendingComment>({ comments, sessionId, format, onRemove, onClear, className }: PendingCommentsBarProps<C>) {
  const draftsStore = useDraftsStore()

  const handleSubmit = useCallback(() => {
    if (comments.length === 0) return
    appendToSessionDraft(draftsStore, sessionId, format(comments), { prepend: false })
    onClear()
    queueMicrotask(() => focusSessionComposer(sessionId))
  }, [comments, sessionId, draftsStore, format, onClear])

  if (comments.length === 0) return null

  return (
    <div className={cn('shrink-0 bg-muted/20', className)}>
      {/* Comment list */}
      <div className="max-h-32 overflow-y-auto px-3 py-2 space-y-1.5">
        {comments.map((comment, i) => (
          <div key={comment.id} className="flex items-start gap-2 text-xs group">
            <span className="text-muted-foreground shrink-0 tabular-nums">{i + 1}.</span>
            <div className="flex-1 min-w-0">
              <div className="text-muted-foreground/70 truncate">{describeAnchor(comment.anchor)}</div>
              <div className="text-foreground whitespace-pre-wrap">{comment.text}</div>
            </div>
            <button
              onClick={() => onRemove(comment.id)}
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
            onClick={onClear}
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
