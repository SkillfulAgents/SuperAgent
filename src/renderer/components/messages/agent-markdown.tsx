import { cn } from '@shared/lib/utils/cn'
import { useCallback, useRef, memo, lazy, Suspense, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import type { ElementContent } from 'hast'
import { Markdown, MarkdownLink, type MarkdownProps } from '@renderer/components/ui/markdown'
import { ErrorBoundary } from '@renderer/components/ui/error-boundary'
import type { EmbeddedImageAliases } from '@renderer/lib/parse-tool-result'
import { CodeCopyButton } from './code-copy-button'
import { useBlockBreakout } from './use-block-breakout'

// How agent-written text looks on every screen that shows it. Screens own only
// their wrapper; parsing and link/image policy stay in ui/markdown.

function CodeBlock({ children }: { children: ReactNode }) {
  const getText = useCallback(() => extractText(children), [children])
  return (
    <pre className={cn(
      'relative group rounded-md p-3 text-sm leading-relaxed border code-scrollbar',
      'bg-black/[0.03] dark:bg-white/[0.06] border-border/60 text-foreground'
    )}>
      <CodeCopyButton getText={getText} />
      {children}
    </pre>
  )
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (!node) return ''
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (typeof node === 'object' && 'props' in node) return extractText(node.props.children)
  return ''
}

// Wide tables break out of the readable column; see useBlockBreakout.
function ExpandingTable({ children }: { children: ReactNode }) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  useBlockBreakout(wrapperRef, scrollerRef, children)

  return (
    <div ref={wrapperRef} className="my-3" data-testid="markdown-table">
      <div ref={scrollerRef} className="code-scrollbar overflow-x-auto">
        <table className="w-max min-w-full border-collapse text-sm">
          {children}
        </table>
      </div>
    </div>
  )
}

const STREAMING_COMPONENTS: Components = {
  // Style code blocks
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  code: ({ children, className }) => {
    const isInline = !className
    // A fence with no language also arrives here without a className, so the
    // chip is scoped to code outside a block. `:where` keeps the scope from
    // adding specificity, so screen wrappers can still restyle the chip.
    return isInline ? (
      <code className={cn(
        '[:where(:not(pre))>&]:rounded [:where(:not(pre))>&]:px-1.5 [:where(:not(pre))>&]:py-0.5 [:where(:not(pre))>&]:text-sm [:where(:not(pre))>&]:font-medium',
        '[:where(:not(pre))>&]:bg-black/[0.05] dark:[:where(:not(pre))>&]:bg-white/[0.08] text-foreground'
      )}>
        {children}
      </code>
    ) : (
      <code className={cn(className, 'text-foreground')}>{children}</code>
    )
  },
  // Wide tables expand beyond the readable column and scroll; see ExpandingTable.
  table: ({ children }) => <ExpandingTable>{children}</ExpandingTable>,
  // Cap individual cell width so prose-heavy cells wrap instead of stretching the
  // table to one giant line, while many short columns still drive the breakout.
  th: ({ children }) => (
    <th className={cn(
      'border-b-2 px-3 py-1.5 text-left font-medium align-top',
      'border-border'
    )}>
      <div className="max-w-[32rem]">{children}</div>
    </th>
  ),
  td: ({ children }) => (
    <td className={cn(
      'border-b px-3 py-1.5 align-top',
      'border-border'
    )}>
      <div className="max-w-[32rem]">{children}</div>
    </td>
  ),
  img: ({ alt, src }) => (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      decoding="async"
      className="h-auto max-w-full rounded-md"
    />
  ),
}

const MermaidDiagram = lazy(() => import('./mermaid-diagram').then(m => ({ default: m.MermaidDiagram })))
const MathBlock = lazy(() => import('./math-block').then(m => ({ default: m.MathBlock })))

function hastText(node: ElementContent): string {
  if (node.type === 'text') return node.value
  if (node.type === 'element') return node.children.map(hastText).join('')
  return ''
}

function fenceSource(pre: ElementContent | undefined, language: string): string | null {
  const code = pre?.type === 'element' ? pre.children[0] : undefined
  if (code?.type !== 'element' || code.tagName !== 'code') return null
  const classes = code.properties.className
  if (!Array.isArray(classes) || !classes.includes(`language-${language}`)) return null
  return hastText(code)
}

const RENDERED_FENCES = [
  { language: 'mermaid', Render: MermaidDiagram },
  { language: 'math', Render: MathBlock },
]

// Only settled blocks render diagrams and equations: a fence still streaming in the
// tail would re-render incomplete output on every delta, so it stays a code block.
const SETTLED_COMPONENTS: Components = {
  ...STREAMING_COMPONENTS,
  pre: ({ children, node }) => {
    const codeBlock = <CodeBlock>{children}</CodeBlock>
    for (const { language, Render } of RENDERED_FENCES) {
      const source = fenceSource(node, language)
      if (source === null) continue
      return (
        <ErrorBoundary fallback={codeBlock}>
          <Suspense fallback={codeBlock}>
            <Render source={source} fallback={codeBlock} />
          </Suspense>
        </ErrorBoundary>
      )
    }
    return codeBlock
  },
}

const MODE_COMPONENTS = { settled: SETTLED_COMPONENTS, streaming: STREAMING_COMPONENTS }

/** Sizes the shared code blocks, inline code and tables down inside an xs-text wrapper. */
export const COMPACT_AGENT_TEXT = '[&_pre]:text-xs/relaxed [&_code]:text-xs [&_table]:text-xs'

export type AgentMarkdownProps = {
  text: string
  /** Enables file:///workspace images through the authenticated workspace route. */
  agentSlug?: string
  imageAliases?: EmbeddedImageAliases
  rehypePlugins?: MarkdownProps['rehypePlugins']
} & (
  // `streaming` keeps fences as code while text still arrives; `settled` draws them.
  // A `link` rebuilds the components on every render, so streaming text cannot take one.
  | { mode: 'settled'; link?: (href: string | undefined, children: ReactNode) => ReactNode | null }
  | { mode: 'streaming'; link?: never }
)

// Memoized so a settled block parses once while later text streams in.
export const AgentMarkdown = memo(function AgentMarkdown({ text, mode, agentSlug, imageAliases, link, rehypePlugins }: AgentMarkdownProps) {
  const components = link
    ? { ...MODE_COMPONENTS[mode], a: (props: Parameters<typeof MarkdownLink>[0]) => link(props.href, props.children) ?? <MarkdownLink {...props} /> }
    : MODE_COMPONENTS[mode]
  return (
    <Markdown components={components} rehypePlugins={rehypePlugins} imageAliases={imageAliases} agentSlug={agentSlug}>
      {text}
    </Markdown>
  )
})
