import { useState } from 'react'
import { ChevronRight, LayoutDashboard } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

/**
 * Under a dashboard comment's bubble: what the app told the agent beside the
 * comment (the page, the pin, the console), folded, so the person reads their
 * own words first and can still see everything that was sent.
 */
export function DashboardCommentContext({ context }: { context: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex w-full flex-col items-end gap-1.5" data-testid="dashboard-comment-context">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs transition-colors hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-500/10 dark:hover:bg-sky-500/15"
      >
        <LayoutDashboard className="h-3 w-3 text-sky-500" aria-hidden />
        <span className="font-medium">Dashboard comment</span>
        <span className="text-muted-foreground">{open ? 'hide context' : 'context sent to the agent'}</span>
        <ChevronRight className={cn('h-3 w-3 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <pre className="max-h-72 w-full max-w-[85%] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/40 p-3 text-left font-mono text-[11px] leading-relaxed text-muted-foreground">
          {context}
        </pre>
      )}
    </div>
  )
}
