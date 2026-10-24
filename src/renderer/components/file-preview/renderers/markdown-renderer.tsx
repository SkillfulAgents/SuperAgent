import { Loader2, AlertCircle } from 'lucide-react'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { useMemo, useRef } from 'react'
import { rehypeCommentLines } from '@renderer/lib/rehype-comment-lines'
import { useCommentBox } from '../comments/use-comment-box'
import { useFileContent } from './use-file-content'
import { splitFrontmatter } from '@renderer/lib/markdown-frontmatter'

const REHYPE_PLUGINS = [rehypeCommentLines]

interface MarkdownRendererProps {
  url: string
  filePath: string
  agentSlug: string
}

export function MarkdownRenderer({ url, filePath, agentSlug }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // Shares the ['file-content', url] cache with the text/CSV renderers, so all
  // consumers of that key must agree on the cached shape (see use-file-content).
  const { data, isLoading, error } = useFileContent(url)
  const content = data?.text
  // A file's frontmatter is its properties, folded away above what it says.
  const { frontmatter, body } = useMemo(() => splitFrontmatter(content ?? ''), [content])
  // New content replaces the blocks, so markers and highlights re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const surface = useMemo(() => ({ text: { blocks: containerRef } }), [content])
  const { box } = useCommentBox(containerRef, surface, filePath, agentSlug)

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
          className="prose prose-sm max-w-none min-w-0 break-words dark:prose-invert [&_[data-comment-lines]]:relative [&_:is(h2,h3,h4,hr)+div>pre]:mt-0 [&>div:first-child>pre]:mt-0 [&>div:last-child>pre]:mb-0"
          data-testid="markdown-renderer"
        >
          {frontmatter !== null && (
            <details className="not-prose mb-4 rounded-md border text-xs" data-testid="markdown-frontmatter">
              <summary className="cursor-pointer select-none px-3 py-1.5 text-muted-foreground">Properties</summary>
              <pre className="whitespace-pre-wrap break-words border-t px-3 py-2 font-mono text-muted-foreground">{frontmatter}</pre>
            </details>
          )}
          <AgentMarkdown text={body} mode="settled" agentSlug={agentSlug} rehypePlugins={REHYPE_PLUGINS} />
          {data?.truncated && (
            <div className="mt-3 pt-3 border-t text-xs text-muted-foreground text-center not-prose">
              File is larger than 5&nbsp;MB and was truncated. Download the file for the full content.
            </div>
          )}
        </div>
      )}
      {box}
    </div>
  )
}
