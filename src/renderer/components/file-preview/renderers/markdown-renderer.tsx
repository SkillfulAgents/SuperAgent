import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { useRef } from 'react'
import { useTextSelection } from '../comments/use-text-selection'
import { CommentOverlay } from '../comments/comment-overlay'

interface MarkdownRendererProps {
  url: string
  filePath: string
}

export function MarkdownRenderer({ url, filePath }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { selection, clearSelection } = useTextSelection(containerRef)

  const { data: content, isLoading, error } = useQuery({
    queryKey: ['file-content', url],
    queryFn: async () => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Failed to load file: ${res.status}`)
      return res.text()
    },
    staleTime: 30_000,
  })

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
        <div className="prose prose-sm max-w-none min-w-0 break-words dark:prose-invert">
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
