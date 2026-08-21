import type { DailyActivityPoint } from '@shared/lib/types/activity'
import { cn } from '@shared/lib/utils/cn'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@renderer/components/ui/chart'
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { dayLabel, plural, summarizeDailyActivity } from './activity-spark-chart'

const activityChartConfig = {
  succeeded: {
    label: 'Succeeded',
    color: 'hsl(160 84% 39%)',
  },
  failed: {
    label: 'Failed',
    color: 'hsl(0 84% 60%)',
  },
} satisfies ChartConfig

interface ActivityBarChartProps {
  label: string
  data: DailyActivityPoint[]
  className?: string
}

/** Larger companion to ActivitySparkChart with a real date axis + hover data. */
export function ActivityBarChart({ label, data, className }: ActivityBarChartProps) {
  const { succeeded, failed, total } = summarizeDailyActivity(data)
  const ticks = data.length > 1
    ? [data[0].date, data[data.length - 1].date]
    : data.map((point) => point.date)
  const accessibleLabel = total === 0
    ? `${label}: no calls over the last ${data.length} ${plural(data.length, 'day')}.`
    : `${label}: ${total} ${plural(total, 'call')} over ${data.length} ${plural(data.length, 'day')}, ${succeeded} succeeded and ${failed} failed.`

  return (
    <ChartContainer
      config={activityChartConfig}
      className={cn('h-[150px] w-full aspect-auto', className)}
      role="img"
      aria-label={accessibleLabel}
      data-testid="activity-bar-chart"
    >
      <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis
          dataKey="date"
          ticks={ticks}
          tickFormatter={dayLabel}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          interval={0}
          padding={{ left: 12, right: 12 }}
        />
        <YAxis hide allowDecimals={false} />
        <ChartTooltip
          cursor={{ fill: 'hsl(var(--muted) / 0.45)' }}
          content={
            <ChartTooltipContent
              labelFormatter={(value) => dayLabel(String(value))}
              valueFormatter={(value) => `${value} ${plural(value, 'call')}`}
            />
          }
        />
        <Bar
          dataKey="succeeded"
          stackId="requests"
          fill="var(--color-succeeded)"
          radius={[2, 2, 0, 0]}
          maxBarSize={22}
          isAnimationActive={false}
        />
        <Bar
          dataKey="failed"
          stackId="requests"
          fill="var(--color-failed)"
          radius={[2, 2, 0, 0]}
          maxBarSize={22}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartContainer>
  )
}
