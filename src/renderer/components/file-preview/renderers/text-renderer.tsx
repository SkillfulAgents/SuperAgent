import { Loader2, AlertCircle } from 'lucide-react'
import { useMemo, useRef } from 'react'
import { useCommentBox } from '../comments/use-comment-box'
import { useFileContent } from './use-file-content'

interface TextRendererProps {
  url: string
  filePath: string
  agentSlug: string
}

export function TextRenderer({ url, filePath, agentSlug }: TextRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { data, isLoading, error } = useFileContent(url)
  // New content replaces the rows, so markers and highlights re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const surface = useMemo(() => ({ text: { blocks: containerRef } }), [data])
  const { box } = useCommentBox(containerRef, surface, filePath, agentSlug)
  const sizeTruncated = data?.truncated ?? false

  const MAX_LINES = 5000
  const allLines = (data?.text || '').split('\n')
  const truncated = allLines.length > MAX_LINES
  const lines = truncated ? allLines.slice(0, MAX_LINES) : allLines

  return (
    <div ref={containerRef} className="relative">
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Failed to load file</span>
        </div>
      ) : (
        <>
        <pre className="p-4 text-xs font-mono leading-relaxed overflow-x-auto">
          <table className="border-collapse">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-muted/30">
                  <td className="pr-4 text-right text-muted-foreground/50 select-none align-top tabular-nums w-[1%] whitespace-nowrap">
                    {i + 1}
                  </td>
                  <td data-comment-lines={`${i + 1}-${i + 1}`} className="relative whitespace-pre-wrap break-all select-text">
                    <span className="select-text">{line || '\n'}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </pre>
        {sizeTruncated && (
          <div className="px-4 py-3 border-t text-xs text-muted-foreground text-center">
            File is larger than 5&nbsp;MB and was truncated. Download the file for the full content.
          </div>
        )}
        {truncated && (
          <div className="px-4 py-3 border-t text-xs text-muted-foreground text-center">
            Showing first {MAX_LINES.toLocaleString()} of {allLines.length.toLocaleString()} lines. Download the file for the full content.
          </div>
        )}
        </>
      )}
      {box}
    </div>
  )
}
