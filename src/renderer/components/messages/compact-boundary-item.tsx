import { useState } from 'react'
import { ChevronDown, ChevronRight, Loader2, Minimize2, ArrowUpRight } from 'lucide-react'
import type { ApiCompactBoundary } from '@shared/lib/types/api'

interface CompactBoundaryItemProps {
  boundary?: ApiCompactBoundary
  isCompacting?: boolean
  /** Navigate to the source session when this is a branched-session context card. */
  onViewSource?: (sessionId: string) => void
}

export function CompactBoundaryItem({ boundary, isCompacting, onViewSource }: CompactBoundaryItemProps) {
  const [expanded, setExpanded] = useState(false)

  // Real-time compacting indicator
  if (isCompacting) {
    return (
      <div className="flex items-center gap-2 py-3 px-4">
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Compacting conversation...</span>
        </div>
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      </div>
    )
  }

  if (!boundary) return null

  return (
    <div className="py-2">
      {/* Dotted line with label */}
      <div className="flex items-center gap-2 px-4">
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <Minimize2 className="h-3 w-3" />
          <span>{boundary.label ?? 'Compacted'}</span>
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <div className="flex-1 border-t border-dashed border-muted-foreground/30" />
      </div>

      {/* Expanded summary */}
      {expanded && boundary.summary && (
        <div className="mt-2 mx-4 p-3 bg-muted/30 rounded-md border text-sm max-h-96 overflow-y-auto">
          <div className="text-xs font-medium tracking-wider text-muted-foreground mb-1">
            {boundary.summaryLabel ?? 'Compaction Summary'}
          </div>
          <div className="text-sm text-foreground/80 whitespace-pre-wrap">
            {boundary.summary}
          </div>
          {boundary.fromSessionId && onViewSource && (
            <button
              onClick={() => onViewSource(boundary.fromSessionId!)}
              className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <ArrowUpRight className="h-3 w-3" />
              View original conversation
            </button>
          )}
        </div>
      )}
    </div>
  )
}
