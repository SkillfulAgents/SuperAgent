import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { renderMermaidSVG } from 'beautiful-mermaid'
import { CodeCopyButton } from './code-copy-button'
import { useBlockBreakout } from './use-block-breakout'

interface MermaidDiagramProps {
  source: string
  /** Shown when the source does not parse or uses an unsupported diagram type. */
  fallback: ReactNode
}

// Theme tokens as CSS variables, so the diagram follows light/dark without re-rendering.
const THEME = {
  bg: 'hsl(var(--background))',
  fg: 'hsl(var(--foreground))',
  muted: 'hsl(var(--muted-foreground))',
  border: 'hsl(var(--border))',
  // Must be set: an unset --accent inherits the app's bare HSL triplet, an invalid color, and arrowheads turn black.
  accent: 'hsl(var(--brand))',
  transparent: true,
}

function renderSvg(source: string): string | null {
  try {
    return renderMermaidSVG(source, THEME)
  } catch {
    return null
  }
}

export function MermaidDiagram({ source, fallback }: MermaidDiagramProps) {
  const svg = useMemo(() => renderSvg(source), [source])
  const getSource = useCallback(() => source, [source])

  // The SVG keeps its natural size; wide diagrams break out like wide tables.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  useBlockBreakout(wrapperRef, scrollerRef, svg)

  if (!svg) return <>{fallback}</>
  return (
    <div ref={wrapperRef} className="relative group my-3" data-testid="mermaid-diagram">
      <div ref={scrollerRef} className="code-scrollbar overflow-x-auto">
        {/* beautiful-mermaid escapes labels and emits no scripts or event handlers. */}
        <div className="w-max" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
      <CodeCopyButton getText={getSource} />
    </div>
  )
}
