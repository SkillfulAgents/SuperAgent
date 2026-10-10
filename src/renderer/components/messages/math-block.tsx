import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'
import { CodeCopyButton } from './code-copy-button'
import { useBlockBreakout } from './use-block-breakout'

interface MathBlockProps {
  source: string
  /** Shown when the LaTeX does not parse. */
  fallback: ReactNode
}

function renderHtml(source: string, displayMode: boolean): string | null {
  try {
    // trust stays off, so \href, \url and \htmlClass cannot emit links or attributes.
    return katex.renderToString(source, { displayMode, throwOnError: true })
  } catch {
    return null
  }
}

export function MathBlock({ source, fallback }: MathBlockProps) {
  const html = useMemo(() => renderHtml(source, true), [source])
  const getSource = useCallback(() => source, [source])

  // Wide equations break out like wide tables instead of overflowing the column.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  useBlockBreakout(wrapperRef, scrollerRef, html)

  if (!html) return <>{fallback}</>
  return (
    <div ref={wrapperRef} className="relative group my-3" data-testid="math-block">
      <div ref={scrollerRef} className="code-scrollbar overflow-x-auto">
        {/* KaTeX escapes its input and emits no scripts or event handlers. */}
        <div className="w-max min-w-full" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <CodeCopyButton getText={getSource} />
    </div>
  )
}

export function MathInline({ source, fallback }: MathBlockProps) {
  const html = useMemo(() => renderHtml(source, false), [source])
  if (!html) return <>{fallback}</>
  return <span data-testid="math-inline" dangerouslySetInnerHTML={{ __html: html }} />
}
