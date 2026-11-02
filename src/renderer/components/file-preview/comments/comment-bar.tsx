import { useCallback } from 'react'
import { MessageSquare, X, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useFilePreview, type FileComment } from '@renderer/context/file-preview-context'
import { appendToSessionDraft, useDraftsStore } from '@renderer/context/drafts-context'
import { focusSessionComposer } from '@renderer/components/messages/composer-focus'
import { cn } from '@shared/lib/utils'
import { describeAnchor } from './anchor'
import type { CommentNoun } from './comment-overlay'
import { getPathName } from '@shared/lib/utils/workspace-path'

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

/** Puts feedback into the session's composer draft, without sending it, and focuses the composer. */
export function submitToComposer(draftsStore: ReturnType<typeof useDraftsStore>, sessionId: string, content: string): void {
  appendToSessionDraft(draftsStore, sessionId, content, { prepend: false })
  queueMicrotask(() => focusSessionComposer(sessionId))
}

/** The file-preview comments on one file. */
export function CommentBar({ comments, filePath, agentSlug, sessionId }: CommentBarProps) {
  const { clearComments, removeComment, commentsEnabled } = useFilePreview()
  const draftsStore = useDraftsStore()

  const handleSubmit = useCallback(() => {
    if (comments.length === 0) return
    submitToComposer(draftsStore, sessionId, formatComments(filePath, comments))
    clearComments(filePath, agentSlug)
  }, [comments, filePath, agentSlug, sessionId, draftsStore, clearComments])

  if (!commentsEnabled) return null

  return (
    <CommentBarView
      className="border-t border-border/40"
      items={comments.map((comment) => ({ id: comment.id, label: describeAnchor(comment.anchor), text: comment.text }))}
      onRemove={(id) => removeComment(filePath, agentSlug, id)}
      onCancel={() => clearComments(filePath, agentSlug)}
      onSubmit={handleSubmit}
    />
  )
}

export interface CommentBarItem {
  id: string
  /** What the note is on. */
  label: string
  text: string
}

interface CommentBarViewProps {
  items: CommentBarItem[]
  onRemove: (id: string) => void
  onCancel: () => void
  onSubmit: () => void
  noun?: CommentNoun
  className?: string
}

function countOf(count: number, noun: CommentNoun): string {
  if (count === 1) return `1 ${noun}`
  return `${count} ${noun === 'reply' ? 'replies' : 'comments'}`
}

/** The notes waiting to go into the composer, with Cancel and Submit. */
export function CommentBarView({ items, onRemove, onCancel, onSubmit, noun = 'comment', className }: CommentBarViewProps) {
  if (items.length === 0) return null

  return (
    <div className={cn('shrink-0 bg-muted/20', className)}>
      {/* Comment list */}
      <div className="max-h-32 overflow-y-auto px-3 py-2 space-y-1.5">
        {items.map((item, i) => (
          <div key={item.id} className="flex items-start gap-2 text-xs group">
            <span className="text-muted-foreground shrink-0 tabular-nums">{i + 1}.</span>
            <div className="flex-1 min-w-0">
              <div className="text-muted-foreground/70 truncate">{item.label}</div>
              <div className="text-foreground whitespace-pre-wrap">{item.text}</div>
            </div>
            <button
              onClick={() => onRemove(item.id)}
              className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              title={`Remove ${noun}`}
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
          <span>{countOf(items.length, noun)}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={onCancel}
          >
            <X className="h-3 w-3 mr-1" />
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={onSubmit}
          >
            Submit
          </Button>
        </div>
      </div>
    </div>
  )
}
