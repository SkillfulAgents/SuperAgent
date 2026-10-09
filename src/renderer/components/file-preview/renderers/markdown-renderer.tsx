import { Loader2, AlertCircle } from 'lucide-react'
import { Markdown } from '@renderer/components/ui/markdown'
import { useEffect, useMemo, useRef } from 'react'
import type { PluggableList } from 'unified'
import { useFilePreview } from '@renderer/context/file-preview-context'
import { useTextSelection } from '../comments/use-text-selection'
import { CommentOverlay } from '../comments/comment-overlay'
import { useFileContent } from './use-file-content'
import { blockEdit, diffEditedLines, rehypeEditHighlight } from './markdown-edit-highlight'
import { reconcileEdits, visibleBefore } from '../file-edits'

// Agent edits are drawn on a pseudo-element of the tagged block, so showing or
// hiding them never moves the text: a tinted band with a bar on the left for a
// changed block, a dashed rule where blocks were removed. Blue, the app's color
// for what is new.
const EDIT_HIGHLIGHT_CLASSES = [
  "[&_[data-edit]]:relative [&_[data-edit]]:before:pointer-events-none [&_[data-edit]]:before:absolute [&_[data-edit]]:before:content-['']",
  '[&_[data-edit=changed]]:before:-left-2 [&_[data-edit=changed]]:before:right-0 [&_[data-edit=changed]]:before:-inset-y-1 [&_[data-edit=changed]]:before:rounded-sm [&_[data-edit=changed]]:before:border-l-2 [&_[data-edit=changed]]:before:border-blue-500 [&_[data-edit=changed]]:before:bg-blue-500/[0.08]',
  '[&_[data-edit^=removed]]:before:inset-x-0 [&_[data-edit^=removed]]:before:border-t-2 [&_[data-edit^=removed]]:before:border-dashed [&_[data-edit^=removed]]:before:border-blue-500/60',
  '[&_[data-edit=removed-above]]:before:-top-2.5 [&_[data-edit=removed-below]]:before:-bottom-2.5',
  // Code blocks and tables scroll sideways, which would clip a band drawn past their edges.
  '[&_pre[data-edit=changed]]:before:inset-0 [&_pre[data-edit=changed]]:before:rounded-lg [&_div[data-edit=changed]]:before:inset-0',
  // A list item's band reaches past its bullet, so its bar lines up with every other block's.
  '[&_li[data-edit=changed]]:before:left-[calc(-1.625em-0.5rem)]',
  // Inside the scroll box too, or the overflow clips the marker.
  '[&_pre[data-edit=removed-above]]:before:top-0 [&_div[data-edit=removed-above]]:before:top-0 [&_pre[data-edit=removed-below]]:before:bottom-0 [&_div[data-edit=removed-below]]:before:bottom-0',
].join(' ')

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
  const { data, isLoading, isPlaceholderData, error } = useFileContent(url)
  const content = data?.text

  const { editsFor, recordShownText } = useFilePreview()
  // A placeholder is the old version kept on screen during a reload, not new text.
  const shown = isPlaceholderData ? undefined : content
  // A file that failed to load (deleted, say) reads as emptied, which hides its highlight.
  const recorded = error ? '' : shown
  useEffect(() => {
    if (recorded !== undefined) recordShownText(filePath, agentSlug, recorded)
  }, [recorded, filePath, agentSlug, recordShownText])
  // Folded at render too, so new text paints with its highlight instead of one frame later.
  const stored = editsFor(filePath, agentSlug)
  const edits = shown === undefined ? stored : reconcileEdits(stored, shown)
  const before = edits?.show && content === edits.now ? visibleBefore(edits) : null
  const rehypePlugins = useMemo<PluggableList | undefined>(() => {
    if (before === null || content === undefined) return undefined
    const lines = diffEditedLines(before, content)
    return lines ? [[rehypeEditHighlight, lines]] : undefined
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
          className={`prose prose-sm max-w-none min-w-0 break-words dark:prose-invert [&_pre_code]:bg-transparent [&_pre_code]:p-0 ${EDIT_HIGHLIGHT_CLASSES}`}
          data-testid="markdown-renderer"
        >
          <Markdown
            rehypePlugins={rehypePlugins}
            components={{
              // `prose` colours a code block for its own dark `pre` background
              // (--tw-prose-pre-code is gray-200). This one is a light tinted
              // card, so the text colour has to come back to the body colour or
              // it reads as grey-on-grey. Matches the chat transcript's block.
              pre: ({ children, node }) => (
                <pre data-edit={blockEdit(node)} className="rounded-lg p-3 text-sm overflow-x-auto border border-border/60 bg-black/[0.03] dark:bg-white/[0.06] text-foreground">
                  {children}
                </pre>
              ),
              code: ({ children, className }) => {
                if (className) {
                  return <code className={className}>{children}</code>
                }
                return (
                  <code className="rounded px-1.5 py-0.5 text-sm font-medium bg-black/[0.03] dark:bg-white/[0.06] text-foreground">
                    {children}
                  </code>
                )
              },
              table: ({ children, node }) => (
                <div data-edit={blockEdit(node)} className="overflow-x-auto">
                  <table className="border-collapse text-sm">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border-b-2 border-border px-3 py-1.5 text-left font-medium">{children}</th>
              ),
              td: ({ children }) => (
                <td className="border-b border-border px-3 py-1.5">{children}</td>
              ),
            }}
          >
            {content || ''}
          </Markdown>
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
          agentSlug={agentSlug}
          onClose={clearSelection}
        />
      )}
    </div>
  )
}
