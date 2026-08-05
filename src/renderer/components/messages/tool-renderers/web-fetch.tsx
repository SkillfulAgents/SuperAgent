import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { markdownUrlTransform } from '@renderer/lib/markdown-url-transform'
import { SiteFavicon } from '@renderer/components/ui/site-favicon'
import { webFetchDef } from '@shared/lib/tool-definitions/web-fetch'
import { hostnameOf, parseFetchResult, stripLeadingTitle } from './web-result-parse'
import { FieldLabel, NO_MARKDOWN_IMAGES, SourceMeta } from './shared'
import type { CollapsedContentProps, ToolRenderer, ToolRendererProps } from './types'

const BOX = 'bg-background rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto card-scrollbar'

/** Site icon for the fetched page, mirroring the source strip on search rows. */
function CollapsedContent({ result, isError }: CollapsedContentProps) {
  const favicon = useMemo(
    () => (result && !isError ? parseFetchResult(result).favicon : undefined),
    [result, isError],
  )
  if (!favicon) return null
  return (
    <span aria-hidden className="flex items-center gap-1 shrink-0">
      <SiteFavicon src={favicon} className="h-3.5 w-3.5" fallback="none" />
    </span>
  )
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  // Title-stripping is part of the parse, not the render: the body can be ~50k chars, and
  // re-deriving it every render would hand ReactMarkdown a fresh string to re-parse each time.
  const parsed = useMemo(() => {
    if (!result) return null
    const p = parseFetchResult(result)
    return { ...p, body: stripLeadingTitle(p.body, p.title) }
  }, [result])
  const { url: inputUrl } = webFetchDef.parseInput(input)

  // Error: keep parity with the generic panel this view replaces (input URL + error text).
  if (isError || !result) {
    return (
      <div className="space-y-2">
        {inputUrl && (
          <div className="text-xs font-medium tracking-wider text-muted-foreground">
            URL: <span className="font-mono">{inputUrl}</span>
          </div>
        )}
        {result && <pre className={`${BOX} text-red-800 dark:text-red-200`}>{result}</pre>}
      </div>
    )
  }

  // No title/url header - the built-in WebFetch tool answers in prose, so there is no page
  // card to build. Show the same labeled Input/Output the generic panel gave these results:
  // the input carries the prompt the model asked the page, which is the context here.
  if (!parsed?.url) {
    return (
      <div className="space-y-2">
        <div>
          <FieldLabel>Input</FieldLabel>
          <pre className={BOX}>
            {typeof input === 'string' ? input : JSON.stringify(input, null, 2)}
          </pre>
        </div>
        <div>
          <FieldLabel>Output</FieldLabel>
          <pre className={BOX}>{result}</pre>
        </div>
      </div>
    )
  }

  // The page controls its own title, and the title lands on the line above the url - so a
  // title containing a newline picks what the parsed url says. Identify the card by the url
  // the agent actually requested, which is what the collapsed row already shows.
  const headerUrl = inputUrl ?? parsed.url

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
        <SiteFavicon src={parsed.favicon} className="h-4 w-4 self-center" />
        <span className="font-medium">{parsed.title ?? headerUrl}</span>
        <SourceMeta host={hostnameOf(headerUrl)} publishedDate={parsed.publishedDate} />
      </div>
      {/* pr-3 keeps the prose out from under the thumb, which overlays the content edge. */}
      <div className="prose prose-sm max-w-none dark:prose-invert text-xs prose-p:text-xs prose-li:text-xs prose-headings:text-xs max-h-64 overflow-y-auto card-scrollbar pr-3">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={markdownUrlTransform}
          components={NO_MARKDOWN_IMAGES}
        >
          {parsed.body}
        </ReactMarkdown>
      </div>
      {parsed.note && <div className="text-xs text-muted-foreground">{parsed.note}</div>}
    </div>
  )
}

export const webFetchRenderer: ToolRenderer = {
  displayName: webFetchDef.displayName,
  icon: Globe,
  getSummary: webFetchDef.getSummary,
  ExpandedView,
  CollapsedContent,
}
