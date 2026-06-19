import { useState } from 'react'
import { ChevronRight } from 'lucide-react'

/**
 * Collapsed-by-default card shown above the new-chat composer when a summary was
 * carried from a previous conversation. Expandable to read the full markdown.
 * Not dismissible: choosing Start with Summary means the summary seeds on send.
 */
export function CarriedSummaryCard({ summary }: { summary: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div data-testid="carried-summary-card" className="mx-auto mb-2 w-full max-w-[740px] px-4">
      <div className="rounded-lg border bg-muted/50">
        <button
          type="button"
          data-testid="carried-summary-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center gap-2 px-4 py-3 text-left"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          <span className="text-sm font-medium">Carried summary of this conversation</span>
        </button>
        {expanded && (
          <div
            data-testid="carried-summary-body"
            className="whitespace-pre-wrap border-t px-4 py-3 text-xs text-muted-foreground"
          >
            {summary}
          </div>
        )}
      </div>
    </div>
  )
}
