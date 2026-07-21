import { ArrowRight, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import {
  ActivityBarChart,
  summarizeDailyActivity,
} from '@renderer/components/activity/activity-spark-chart'
import { useConnectionActivityStats } from '@renderer/hooks/use-activity-stats'
import type { UnifiedRow } from '@renderer/components/connections/unified-rows'

interface ConnectionUsageCardProps {
  row: UnifiedRow
  onViewLogs: () => void
}

export function ConnectionUsageCard({ row, onViewLogs }: ConnectionUsageCardProps) {
  const { data: activityStats, isPending } = useConnectionActivityStats()
  const activity = activityStats?.connectionById[row.key]
  const summary = activity ? summarizeDailyActivity(activity) : null

  return (
    <section className="space-y-2 min-w-0">
      <h3 className="text-xs font-normal text-muted-foreground">Usage</h3>
      <div className="rounded-xl border bg-background overflow-hidden" data-testid="connection-usage-card">
        <div className="p-4 pb-2">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div>
              <p className="text-sm font-medium tabular-nums">
                {summary ? summary.total.toLocaleString() : '—'} calls
              </p>
              <p className="text-[11px] text-muted-foreground">
                Last {activityStats?.days ?? 14} days
              </p>
            </div>
            {summary && (
              <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-emerald-500" aria-hidden="true" />
                  {summary.succeeded.toLocaleString()} succeeded
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-sm bg-red-500" aria-hidden="true" />
                  {summary.failed.toLocaleString()} failed
                </span>
              </div>
            )}
          </div>

          {activity ? (
            <ActivityBarChart label={`${row.name} activity`} data={activity} />
          ) : isPending ? (
            <div className="h-[150px] flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading usage...
            </div>
          ) : (
            <div className="h-[150px] flex items-center justify-center text-xs text-muted-foreground">
              Usage data is unavailable.
            </div>
          )}
        </div>

        <div className="border-t px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-between text-xs"
            onClick={onViewLogs}
          >
            View logs
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </section>
  )
}
