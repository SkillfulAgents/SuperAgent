import { useState, useEffect, useMemo } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@renderer/components/ui/chart'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts'
import { AlertTriangle, ExternalLink, RefreshCw, Loader2 } from 'lucide-react'
import { useUsageData } from '@renderer/hooks/use-usage'
import { useModelConfig } from '@renderer/hooks/use-settings'
import { useUser } from '@renderer/context/user-context'
import { format, parseISO } from 'date-fns'
import type { LlmProviderId } from '@shared/lib/config/settings'

type Segmentation = 'total' | 'byModel' | 'byAgent'

const DAY_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
]

const COLORS = [
  'hsl(215, 70%, 60%)',
  'hsl(150, 60%, 45%)',
  'hsl(35, 90%, 55%)',
  'hsl(280, 60%, 60%)',
  'hsl(0, 70%, 55%)',
  'hsl(180, 50%, 50%)',
  'hsl(60, 70%, 50%)',
  'hsl(320, 60%, 55%)',
]

const PROVIDER_USAGE_LINKS: Partial<Record<LlmProviderId, { label: string; href: string }>> = {
  anthropic: {
    label: 'Anthropic API Console',
    href: 'https://platform.claude.com/usage',
  },
  openrouter: {
    label: 'OpenRouter Activity dashboard',
    href: 'https://openrouter.ai/activity',
  },
  platform: {
    label: 'Gamut Platform',
    href: 'https://platform.gamutagents.com',
  },
}

export function UsageTab() {
  const { isAuthMode, isAdmin } = useUser()
  const { data: modelConfig } = useModelConfig()
  const [days, setDays] = useState(7)
  const [globalView, setGlobalView] = useState(!isAuthMode || isAdmin)
  const [segmentation, setSegmentation] = useState<Segmentation>('total')
  const { data, isLoading, isFetching, refetch } = useUsageData(days, globalView)

  useEffect(() => {
    refetch()
  }, [days, globalView, refetch])

  const segments = useMemo(() => {
    if (segmentation === 'total') return [{ key: 'cost', label: 'Cost' }]

    const seen = new Map<string, string>()
    for (const day of data?.daily || []) {
      if (segmentation === 'byModel') {
        for (const m of day.byModel) seen.set(m.model, m.model)
      } else {
        for (const a of day.byAgent) seen.set(a.agentSlug, a.agentName)
      }
    }
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }))
  }, [data, segmentation])

  const chartConfig = useMemo(() => {
    const config: ChartConfig = {}
    for (let i = 0; i < segments.length; i++) {
      const { key, label } = segments[i]
      config[key] = {
        label,
        color: COLORS[i % COLORS.length],
      }
    }
    return config
  }, [segments])

  const chartData = useMemo(() => {
    if (!data?.daily) return []

    return data.daily.map((day) => {
      const entry: Record<string, unknown> = {
        date: format(parseISO(day.date), 'MMM d'),
      }

      if (segmentation === 'total') {
        entry.cost = day.totalCost
      } else if (segmentation === 'byModel') {
        for (const m of day.byModel) {
          entry[m.model] = m.cost
        }
      } else {
        for (const a of day.byAgent) {
          entry[a.agentSlug] = a.cost
        }
      }

      return entry
    })
  }, [data, segmentation])

  const totalCost = data?.daily?.reduce((sum, d) => sum + d.totalCost, 0) ?? 0
  const providerUsageLink = modelConfig?.llmProvider
    ? PROVIDER_USAGE_LINKS[modelConfig.llmProvider]
    : undefined

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium mb-1">LLM Usage</h3>
        <p className="text-xs text-muted-foreground">
          Token costs across {isAuthMode && !globalView ? 'your' : 'all'} agents, computed from session logs.
        </p>
      </div>

      <Alert className="border-amber-500/30 bg-amber-500/5">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle>Usage and cost estimates may be incomplete</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          These estimates only include agents and sessions that haven&apos;t been deleted, so your
          actual usage and costs may be higher. For definitive totals, check{' '}
          {providerUsageLink ? (
            <a
              href={providerUsageLink.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-4 hover:text-primary"
            >
              {providerUsageLink.label}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            "your provider's billing dashboard"
          )}
          .
        </AlertDescription>
      </Alert>

      <div className="flex items-center gap-3">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-[140px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={segmentation}
          onValueChange={(v) => setSegmentation(v as Segmentation)}
        >
          <SelectTrigger className="w-[140px] h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="total">Total</SelectItem>
            <SelectItem value="byModel">By Model</SelectItem>
            <SelectItem value="byAgent">By Agent</SelectItem>
          </SelectContent>
        </Select>

        {isAuthMode && isAdmin && (
          <Select value={globalView ? 'global' : 'mine'} onValueChange={(v) => setGlobalView(v === 'global')}>
            <SelectTrigger className="w-[140px] h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mine">My Agents</SelectItem>
              <SelectItem value="global">All Agents</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Button
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`}
          />
          Refresh
        </Button>
      </div>

      {isLoading || (isFetching && !data) ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            Loading usage data...
          </span>
        </div>
      ) : !data?.daily?.length ? (
        <div className="text-center py-12">
          <p className="text-sm text-muted-foreground">
            No usage data found for the selected period.
          </p>
        </div>
      ) : (
        <>
          <ChartContainer
            config={chartConfig}
            className="min-h-[200px] max-h-[240px] w-full"
          >
            <BarChart data={chartData}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `$${v.toFixed(2)}`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    valueFormatter={(value) =>
                      `$${(value as number).toFixed(2)}`
                    }
                  />
                }
              />
              {segmentation !== 'total' && (
                <ChartLegend content={<ChartLegendContent />} />
              )}
              {segments.map(({ key }) => (
                <Bar
                  key={key}
                  dataKey={key}
                  stackId={segmentation !== 'total' ? 'stack' : undefined}
                  fill={`var(--color-${key})`}
                  radius={
                    segmentation === 'total' ? [4, 4, 0, 0] : undefined
                  }
                />
              ))}
            </BarChart>
          </ChartContainer>

          <div className="text-right">
            <span className="text-sm text-muted-foreground">
              Total:{' '}
              <span className="font-medium text-foreground">
                ${totalCost.toFixed(2)}
              </span>
            </span>
          </div>
        </>
      )}
    </div>
  )
}
