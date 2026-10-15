import { Loader2, AlertCircle } from 'lucide-react'
import { AgentMarkdown } from '@renderer/components/messages/agent-markdown'
import { useEffect, useMemo, useRef } from 'react'
import type { PluggableList } from 'unified'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { rehypeCommentLines } from '@renderer/lib/rehype-comment-lines'
import { useCommentBox } from '../comments/use-comment-box'
import { useFileContent } from './use-file-content'
import { diffEditedLines, rehypeEditHighlight } from './markdown-edit-highlight'
import { reconcileEdits, sameText, visibleBefore } from '../file-edits'

// Agent edits are drawn on a pseudo-element of the tagged block, so showing or
// hiding them never moves the text: a tinted band with a bar on the left for a
// changed block, a dashed rule where blocks were removed. Amber, so it
// reads as an edit.
const EDIT_HIGHLIGHT_CLASSES = [
  "[&_[data-edit]]:relative [&_[data-edit]]:before:pointer-events-none [&_[data-edit]]:before:absolute [&_[data-edit]]:before:content-['']",
  '[&_[data-edit=changed]]:before:-left-2 [&_[data-edit=changed]]:before:right-0 [&_[data-edit=changed]]:before:-inset-y-1 [&_[data-edit=changed]]:before:rounded-sm [&_[data-edit=changed]]:before:border-l-2 [&_[data-edit=changed]]:before:border-amber-500 [&_[data-edit=changed]]:before:bg-amber-500/10',
  '[&_[data-edit^=removed]]:before:inset-x-0 [&_[data-edit^=removed]]:before:border-t-2 [&_[data-edit^=removed]]:before:border-dashed [&_[data-edit^=removed]]:before:border-amber-500/60',
  '[&_[data-edit=removed-above]]:before:-top-2.5 [&_[data-edit=removed-below]]:before:-bottom-2.5',
  // A list item's band reaches past its bullet, so its bar lines up with every other block's.
  '[&_li[data-edit=changed]]:before:left-[calc(-1.625em-0.5rem)]',
].join(' ')

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
  const { data, isLoading, isPlaceholderData, error } = useFileContent(url)
  const content = data?.text
  // New content replaces the blocks, so markers and highlights re-read them.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const surface = useMemo(() => ({ text: { blocks: containerRef } }), [content])
  const { box } = useCommentBox(containerRef, surface, filePath, agentSlug)

  const { editsFor, recordShownText } = useFilePreview()
  // A placeholder is the old version kept on screen during a reload, not new text.
  const shown = isPlaceholderData ? undefined : content
  const stored = editsFor(filePath, agentSlug)
  // A file that fails to load after showing text (deleted, say) reads as emptied, which hides its highlight.
  const recorded = error ? (stored ? '' : undefined) : shown
  useEffect(() => {
    if (recorded !== undefined) recordShownText(filePath, agentSlug, recorded)
  }, [recorded, filePath, agentSlug, recordShownText])
  // Folded at render too, so new text paints with its highlight instead of one frame later.
  const edits = shown === undefined ? stored : reconcileEdits(stored, shown)
  const before = edits?.show && content !== undefined && sameText(content, edits.now) ? visibleBefore(edits) : null
  const rehypePlugins = useMemo<PluggableList>(() => {
    if (before === null || content === undefined) return REHYPE_PLUGINS
    const lines = diffEditedLines(before, content)
    return lines ? [...REHYPE_PLUGINS, [rehypeEditHighlight, lines]] : REHYPE_PLUGINS
  }, [before, content])

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
          className={`prose prose-sm max-w-none min-w-0 break-words dark:prose-invert [&_[data-comment-lines]]:relative [&_:is(h2,h3,h4,hr)+div>pre]:mt-0 [&>div:first-child>pre]:mt-0 [&>div:last-child>pre]:mb-0 ${EDIT_HIGHLIGHT_CLASSES}`}
          data-testid="markdown-renderer"
        >
          <AgentMarkdown text={content || ''} mode="settled" agentSlug={agentSlug} rehypePlugins={rehypePlugins} />
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
