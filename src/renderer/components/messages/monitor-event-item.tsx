import { Radar } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import type { ApiMonitorEvent } from '@shared/lib/types/api'

interface MonitorEventItemProps {
  item: ApiMonitorEvent
}

/**
 * What a Monitor watch printed, where the runtime delivered it. Each batch
 * woke the agent for a turn, so without this row the agent's reaction reads
 * as unprompted. The batch that ends the watch also says how it ended, in the
 * runtime's words ("stream ended", "script failed (exit 3)").
 */
export function MonitorEventItem({ item }: MonitorEventItemProps) {
  const failed = item.status === 'failed'
  return (
    // As wide as an assistant message, so it lines up with the Monitor card above.
    <div className="flex max-w-[80%] items-start gap-2 text-xs" data-testid="monitor-event-item" data-task-id={item.taskId}>
      <Radar className="mt-px h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <span className="shrink-0 text-foreground/70">Monitor</span>
          {item.description && <span className="truncate">{item.description}</span>}
          {item.endReason && (
            <>
              <span aria-hidden className="shrink-0">·</span>
              <span className={cn('shrink-0', failed && 'text-destructive')}>{item.endReason}</span>
            </>
          )}
        </div>
        {item.events.length > 0 && (
          <div
            className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border/70 bg-muted/40 font-mono text-foreground/80"
            data-testid="monitor-event-lines"
          >
            {item.events.map((event, index) => (
              <pre
                key={index}
                className={cn('m-0 whitespace-pre-wrap break-words px-2 py-1.5', index > 0 && 'border-t border-border/70')}
              >
                {event}
              </pre>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
