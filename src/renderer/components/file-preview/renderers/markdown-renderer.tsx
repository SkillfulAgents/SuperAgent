import { Loader2, AlertCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { useRef } from 'react'
import { useTextSelection } from '../comments/use-text-selection'
import { CommentOverlay } from '../comments/comment-overlay'
import { useFileContent } from './use-file-content'

interface MarkdownRendererProps {
  url: string
  filePath: string
  commentsEnabled?: boolean
}

export function MarkdownRenderer({ url, filePath, commentsEnabled = true }: MarkdownRendererProps) {
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
        <div className="prose prose-sm max-w-none min-w-0 break-words dark:prose-invert" data-testid="markdown-renderer">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={markdownUrlTransform}
            components={{
              pre: ({ children }) => (
                <pre className="rounded-lg p-3 text-sm overflow-x-auto bg-black/[0.03] dark:bg-white/[0.06]">
                  {children}
                </pre>
              ),
              code: ({ children, className }) => {
                if (className) {
                  return <code className={className}>{children}</code>
                }
                return (
                  <code className="rounded px-1.5 py-0.5 text-sm font-medium bg-black/[0.03] dark:bg-white/[0.06]">
                    {children}
                  </code>
                )
              },
              table: ({ children }) => (
                <div className="overflow-x-auto">
                  <table className="border-collapse text-sm">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b-2 border-border px-3 py-1.5 text-left font-semibold">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border-b border-border px-3 py-1.5">{children}</td>
              ),
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
                  {children}
                </a>
              ),
            }}
          >
            {content || ''}
          </ReactMarkdown>
          {data?.truncated && (
            <div className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center not-prose">
              File is larger than 5&nbsp;MB and was truncated. Download the file for the full content.
            </div>
          )}
        </div>
      )}
      {selection && (
        <CommentOverlay
          selection={selection}
          filePath={filePath}
          onClose={clearSelection}
        />
      )}
    </div>
  )
}
