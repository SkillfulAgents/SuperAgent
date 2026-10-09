import { Loader2, AlertCircle } from 'lucide-react'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { useRef } from 'react'
import { useTextSelection } from '../comments/use-text-selection'
import { CommentOverlay } from '../comments/comment-overlay'
import { selectionToAnchor } from '../comments/anchor'
import { useFileContent } from './use-file-content'

interface MarkdownRendererProps {
  url: string
  filePath: string
  agentSlug: string
  commentsEnabled?: boolean
}

export function MarkdownRenderer({ url, filePath, agentSlug, commentsEnabled = true }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { selection, clearSelection } = useTextSelection(containerRef, commentsEnabled)

  // Shares the ['file-content', url] cache with the text/CSV renderers, so all
  // consumers of that key must agree on the cached shape (see use-file-content).
  const { data, isLoading, error } = useFileContent(url)
  const content = data?.text

  return (
    <div ref={containerRef} className="relative p-4">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Failed to load file</span>
        </div>
      ) : (
        <div
          className="prose prose-sm max-w-none min-w-0 break-words dark:prose-invert"
          data-testid="markdown-renderer"
        >
          <AgentMarkdown text={content || ''} mode="settled" agentSlug={agentSlug} />
          {data?.truncated && (
            <div className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center not-prose">
              File is larger than 5&nbsp;MB and was truncated. Download the file for the full content.
            </div>
          )}
        </div>
      )}
      {selection && (
        <CommentOverlay
          anchor={selectionToAnchor(selection)}
          rect={selection.rect}
          filePath={filePath}
          agentSlug={agentSlug}
          onClose={clearSelection}
        />
      )}
    </div>
  )
}
