import { useMemo } from 'react'
import { Search } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform, safeHref } from '@renderer/lib/markdown-url-transform'
import { SiteFavicon } from '@renderer/components/ui/site-favicon'
import { webSearchDef } from '@shared/lib/tool-definitions/web-search'
import { flattenSnippet, hostnameOf, parseSearchResult, stripLeadingTitle } from './web-result-parse'
import { NO_MARKDOWN_IMAGES, SourceMeta } from './shared'
import type { CollapsedContentProps, ToolRenderer, ToolRendererProps } from './types'

const MAX_COLLAPSED_ICONS = 5
const PROSE = 'prose prose-sm max-w-none dark:prose-invert text-xs prose-p:text-xs prose-li:text-xs prose-headings:text-xs'

function snippetOf(source: { title: string; snippet?: string }): string {
  return source.snippet ? flattenSnippet(stripLeadingTitle(source.snippet, source.title)) : ''
}

function SourceLink({ title, url }: { title: string; url: string }) {
  // safeHref returns '' for blocked/hostile URLs (markdown-url-transform.ts:16-27);
  // linkify.tsx:74-75 is the precedent for skipping empty hrefs.
  const href = safeHref(url)
  if (!href) return <span>{title}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
      {title}
    </a>
  )
}

function CollapsedContent({ result, isError }: CollapsedContentProps) {
  const sources = useMemo(
    () => (result && !isError ? parseSearchResult(result).sources : []),
    [result, isError],
  )
  if (sources.length === 0) return null
  const shown = sources.slice(0, MAX_COLLAPSED_ICONS)
  return (
    <span aria-hidden className="flex items-center gap-1 shrink-0">
      {shown.map((s, i) => (
        <SiteFavicon key={`${i}-${s.url}`} src={s.favicon} className="h-3.5 w-3.5" />
      ))}
      {sources.length > shown.length && (
        <span className="text-2xs text-muted-foreground">+{sources.length - shown.length}</span>
      )}
    </span>
  )
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { query } = webSearchDef.parseInput(input)
  const { sources, leftover } = useMemo(() => parseSearchResult(result ?? ''), [result])

  if (isError || !result) {
    return (
      <div className="space-y-2">
        {query && (
          <div className="text-xs font-medium tracking-wider text-muted-foreground">
            Query: <span className="font-mono">{query}</span>
          </div>
        )}
        {result && (
          <pre className="bg-background text-red-800 dark:text-red-200 rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto card-scrollbar">
            {result}
          </pre>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {sources.length > 0 && (
        <div>
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">
            Sources ({sources.length})
          </div>
          <ul className="space-y-2">
            {sources.map((s, i) => (
              <li key={`${i}-${s.url}`} className="flex gap-2 text-xs">
                <SiteFavicon src={s.favicon} className="h-4 w-4 mt-0.5" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <SourceLink title={s.title} url={s.url} />
                    <SourceMeta host={hostnameOf(s.url)} publishedDate={s.publishedDate} />
                  </div>
                  {snippetOf(s) && (
                    // One paragraph, with the title repeat dropped: the raw snippet is page text
                    // that opens with the same title this row already links.
                    <div className={`${PROSE} mt-0.5 text-muted-foreground`}>
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        urlTransform={markdownUrlTransform}
                        components={NO_MARKDOWN_IMAGES}
                      >
                        {snippetOf(s)}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {leftover && (
        <div className={PROSE}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={markdownUrlTransform}
            components={NO_MARKDOWN_IMAGES}
          >
            {leftover}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

export const webSearchRenderer: ToolRenderer = {
  displayName: webSearchDef.displayName,
  icon: Search,
  getSummary: webSearchDef.getSummary,
  ExpandedView,
  CollapsedContent,
}
