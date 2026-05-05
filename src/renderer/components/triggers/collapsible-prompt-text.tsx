import { useLayoutEffect, useRef, useState } from 'react'

interface CollapsiblePromptTextProps {
  text: string
  maxLines?: number
}

export function CollapsiblePromptText({ text, maxLines = 5 }: CollapsiblePromptTextProps) {
  const [expanded, setExpanded] = useState(false)
  const [showToggle, setShowToggle] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (expanded) return
    const el = ref.current
    if (!el) return
    setShowToggle(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded, maxLines])

  const clampStyle = expanded
    ? undefined
    : {
        display: '-webkit-box',
        WebkitLineClamp: maxLines,
        WebkitBoxOrient: 'vertical' as const,
        overflow: 'hidden',
      }

  return (
    <div>
      <div ref={ref} className="whitespace-pre-wrap text-xs" style={clampStyle}>
        {text}
      </div>
      {showToggle && (
        <button
          type="button"
          className="mt-2 ml-auto block text-xs text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'See less' : 'See more'}
        </button>
      )}
    </div>
  )
}
