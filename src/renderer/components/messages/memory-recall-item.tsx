import { useState } from 'react'
import { BookOpen, ChevronDown, ChevronRight } from 'lucide-react'
import type { ApiMemoryRecall } from '@shared/lib/types/api'

interface MemoryRecallItemProps {
  recall: ApiMemoryRecall
}

/** Extract a short display name from a memory file path (e.g. "/home/claude/.claude/..." -> filename) */
function displayPath(p: string): string {
  const segments = p.split('/')
  return segments[segments.length - 1] || p
}

export function MemoryRecallItem({ recall }: MemoryRecallItemProps) {
  const [expanded, setExpanded] = useState(false)

  if (!recall.memoryPaths.length) return null

  return (
    <div className="py-1">
      <div className="flex items-center gap-2 px-4">
        <div className="flex-1 border-t border-dotted border-muted-foreground/20" />
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <BookOpen className="h-3 w-3" />
          <span>Recalled memory</span>
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
        <div className="flex-1 border-t border-dotted border-muted-foreground/20" />
      </div>

      {expanded && (
        <div className="mt-1.5 mx-4 px-3 py-2 bg-muted/30 rounded-md border text-xs text-muted-foreground">
          {recall.memoryPaths.map((p) => (
            <div key={p} className="truncate" title={p}>
              {displayPath(p)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
