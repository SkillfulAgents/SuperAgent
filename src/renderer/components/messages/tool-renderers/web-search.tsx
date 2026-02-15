
import { Globe } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ToolRenderer, ToolRendererProps } from './types'

interface WebSearchInput {
  query?: string
}

interface SearchLink {
  title: string
  url: string
}

function parseWebSearchInput(input: unknown): WebSearchInput {
  if (typeof input === 'object' && input !== null) {
    return input as WebSearchInput
  }
  return {}
}

function getSummary(input: unknown): string | null {
  const { query } = parseWebSearchInput(input)
  return query ?? null
}

function parseSearchResult(result: string): { links: SearchLink[]; markdown: string } {
  const links: SearchLink[] = []
  let markdown = result

  // Try to find and parse the Links: [...] JSON array
  const linksMatch = result.match(/Links:\s*(\[[\s\S]*?\])\s*\n/)
  if (linksMatch) {
    try {
      const parsed = JSON.parse(linksMatch[1])
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.title && item.url) {
            links.push({ title: item.title, url: item.url })
          }
        }
      }
    } catch {
      // Failed to parse links
    }
    // Remove everything up to and including the Links JSON from markdown content
    const afterLinks = result.indexOf(linksMatch[0]) + linksMatch[0].length
    markdown = result.slice(afterLinks).trim()
  } else {
    // If no Links section, strip the header line and show the rest
    const lines = result.split('\n')
    if (lines[0]?.startsWith('Web search results for query:')) {
      markdown = lines.slice(1).join('\n').trim()
    }
  }

  return { links, markdown }
}

function ExpandedView({ input, result, isError }: ToolRendererProps) {
  const { query } = parseWebSearchInput(input)

  if (isError || !result) {
    return (
      <div className="space-y-2">
        {query && (
          <div className="text-xs font-medium text-muted-foreground">
            Query: <span className="font-mono">{query}</span>
          </div>
        )}
        {result && (
          <pre className="bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 rounded p-2 text-xs overflow-x-auto max-h-40 overflow-y-auto">
            {result}
          </pre>
        )}
      </div>
    )
  }

  const { links, markdown } = parseSearchResult(result)

  return (
    <div className="space-y-3">
      {/* Links list */}
      {links.length > 0 && (
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-1">
            Sources ({links.length})
          </div>
          <ul className="space-y-1">
            {links.map((link, i) => (
              <li key={i} className="text-xs">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-500 hover:underline"
                >
                  {link.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Markdown content */}
      {markdown && (
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {markdown}
          </ReactMarkdown>
        </div>
      )}
    </div>
  )
}

export const webSearchRenderer: ToolRenderer = {
  displayName: 'Web Search',
  icon: Globe,
  getSummary,
  ExpandedView,
}
