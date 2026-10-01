import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { CodeCopyButton } from './code-copy-button'
import { useBlockBreakout } from './use-block-breakout'

interface MermaidDiagramProps {
  source: string
  /** Shown when the source does not parse or uses an unsupported diagram type. */
  fallback: ReactNode
}

// Theme tokens as CSS variables, so the diagram follows light/dark without re-rendering.
// `border` is left unset: the SVG would get `--border:hsl(var(--border))`, a self-reference
// CSS treats as invalid. The library then derives node strokes from fg/bg instead.
const THEME = {
  bg: 'hsl(var(--background))',
  fg: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted-foreground))',
  // Must be set: an unset --accent inherits the app's bare HSL triplet, an invalid color, and arrowheads turn black.
  accent: 'hsl(var(--brand))',
  transparent: true,
}

function renderSvg(source: string): string | null {
  try {
    // The embedded <style> pulls fonts from Google; the app already loads Inter itself.
    return renderMermaidSVG(source, THEME).replace(/@import url\([^)]*\);/g, '')
  } catch {
    return null
  }
}

export function MermaidDiagram({ source, fallback }: MermaidDiagramProps) {
  const svg = useMemo(() => renderSvg(source), [source])
  const getSource = useCallback(() => source, [source])

  // The SVG's <style> has bare `text`/`svg` selectors; a shadow root keeps them off the rest of the app.
  const hostRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host || !svg) return
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    root.innerHTML = svg
  }, [svg])

  // The SVG keeps its natural size; wide diagrams break out like wide tables.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  useBlockBreakout(wrapperRef, scrollerRef, svg)

  if (!svg) return <>{fallback}</>
  return (
    <div ref={wrapperRef} className="relative group my-3" data-testid="mermaid-diagram">
      <div ref={scrollerRef} className="code-scrollbar overflow-x-auto">
        {/* beautiful-mermaid escapes labels and emits no scripts or event handlers. */}
        <div ref={hostRef} className="w-max" />
      </div>
      <CodeCopyButton getText={getSource} />
    </div>
  )
}
