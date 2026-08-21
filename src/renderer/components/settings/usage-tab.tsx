import { useMemo, useState } from 'react'
import { format, parseISO } from 'date-fns'
import {
  AlertTriangle,
  Bot,
  CalendarDays,
  ExternalLink,
  Gauge,
  RefreshCw,
  Sparkles,
} from 'lucide-react'
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts'
import { Alert, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@renderer/components/ui/chart'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  useFullWidthSettingsContent,
  useHideSettingsHeader,
} from '@renderer/components/settings/settings-page'
import { useUser } from '@renderer/context/user-context'
import { useSettings } from '@renderer/hooks/use-settings'
import { useUsageData } from '@renderer/hooks/use-usage'
import type { LlmProviderId } from '@shared/lib/config/settings'
import { cn } from '@shared/lib/utils/cn'

type Segmentation = 'byModel' | 'byAgent'
type Metric = 'cost' | 'tokens'

interface BreakdownRow {
  key: string
  label: string
  cost: number
  totalTokens: number
}

interface ChartSegment {
  key: string
  label: string
  sourceKeys: Set<string>
}

interface UsageSelection {
  key: string
  label: string
  sourceKeys: string[]
  colorIndex: number
}

const DAY_OPTIONS = [7, 14, 30]
const MAX_CHART_SEGMENTS = 5

const CHART_COLORS = [
  { light: 'hsl(12 76% 54%)', dark: 'hsl(12 76% 61%)' },
  { light: 'hsl(173 58% 36%)', dark: 'hsl(160 60% 45%)' },
  { light: 'hsl(215 62% 48%)', dark: 'hsl(220 70% 58%)' },
  { light: 'hsl(36 82% 52%)', dark: 'hsl(30 80% 58%)' },
  { light: 'hsl(278 52% 55%)', dark: 'hsl(280 65% 66%)' },
  { light: 'hsl(210 10% 56%)', dark: 'hsl(210 10% 50%)' },
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

const compactNumberFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function formatCompactNumber(value: number): string {
  return compactNumberFormatter.format(value)
}

function formatCurrency(value: number, compact = false): string {
  if (compact && Math.abs(value) >= 1_000) {
    return `$${formatCompactNumber(value)}`
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

function dateRangeLabel(dates: string[]): string {
  if (dates.length === 0) return ''
  const first = parseISO(dates[0])
  const last = parseISO(dates[dates.length - 1])
  if (dates.length === 1) return format(first, 'MMM d, yyyy')
  if (first.getFullYear() !== last.getFullYear()) {
    return `${format(first, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`
  }
  return `${format(first, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`
}

/** Infer the bundled vendor mark from the provider-qualified or canonical model id. */
function modelProviderIcon(model: string): string | undefined {
  const id = model.toLowerCase()
  if (id.startsWith('anthropic/') || id.includes('claude')) return 'anthropic'
  if (
    id.startsWith('openai/') ||
    id.includes('/gpt-') ||
    /^(?:gpt|codex|o[134](?:-|$))/.test(id)
  ) return 'openai'
  if (id.startsWith('x-ai/') || id.startsWith('xai/') || id.includes('grok')) return 'xai'
  if (id.startsWith('moonshot/') || id.includes('kimi')) return 'kimi'
  if (id.startsWith('z-ai/') || id.startsWith('zai/') || id.includes('glm')) return 'zai'
  if (id.startsWith('meta/') || id.includes('llama')) return 'meta'
  return undefined
}

export function UsageTab() {
  useFullWidthSettingsContent(true)
  useHideSettingsHeader(true)

  const { isAuthMode, isAdmin } = useUser()
  const { data: settings } = useSettings()
  const [days, setDays] = useState(7)
  const [globalView, setGlobalView] = useState(!isAuthMode || isAdmin)
  const [segmentation, setSegmentation] = useState<Segmentation>('byModel')
  const [metric, setMetric] = useState<Metric>('cost')
  const [selection, setSelection] = useState<UsageSelection | null>(null)
  const { data, isLoading, isFetching, refetch } = useUsageData(days, globalView)

  const daily = useMemo(() => data?.daily ?? [], [data?.daily])
  const totalCost = daily.reduce((sum, day) => sum + day.totalCost, 0)
  const totalTokens = daily.reduce((sum, day) => sum + day.totalTokens, 0)
  const activeDays = daily.filter((day) => day.totalCost > 0 || day.totalTokens > 0).length
  const dateRange = dateRangeLabel(daily.map((day) => day.date))
  const hasUsage = totalCost > 0 || totalTokens > 0

  const breakdown = useMemo<BreakdownRow[]>(() => {
    const aggregate = new Map<string, BreakdownRow>()

    for (const day of daily) {
      if (segmentation === 'byModel') {
        for (const item of day.byModel) {
          const existing = aggregate.get(item.model)
          aggregate.set(item.model, {
            key: item.model,
            label: item.model,
            cost: (existing?.cost ?? 0) + item.cost,
            totalTokens: (existing?.totalTokens ?? 0) + (item.totalTokens ?? 0),
          })
        }
      } else {
        for (const item of day.byAgent) {
          const existing = aggregate.get(item.agentSlug)
          aggregate.set(item.agentSlug, {
            key: item.agentSlug,
            label: item.agentName,
            cost: (existing?.cost ?? 0) + item.cost,
            totalTokens: (existing?.totalTokens ?? 0) + item.totalTokens,
          })
        }
      }
    }

    return Array.from(aggregate.values()).sort((a, b) => b.cost - a.cost)
  }, [daily, segmentation])

  const chartSegments = useMemo<ChartSegment[]>(() => {
    const ranked = [...breakdown].sort((a, b) => {
      const aValue = metric === 'cost' ? a.cost : a.totalTokens
      const bValue = metric === 'cost' ? b.cost : b.totalTokens
      return bValue - aValue
    })
    const visible = ranked.slice(0, MAX_CHART_SEGMENTS).map((row, index) => ({
      key: `series${index}`,
      label: row.label,
      sourceKeys: new Set([row.key]),
    }))

    if (ranked.length > MAX_CHART_SEGMENTS) {
      visible.push({
        key: `series${MAX_CHART_SEGMENTS}`,
        label: 'Other',
        sourceKeys: new Set(ranked.slice(MAX_CHART_SEGMENTS).map((row) => row.key)),
      })
    }

    return visible
  }, [breakdown, metric])

  const activeSelection = useMemo(() => {
    if (!selection) return null
    const availableKeys = new Set(breakdown.map((row) => row.key))
    const sourceKeys = selection.sourceKeys.filter((key) => availableKeys.has(key))
    return sourceKeys.length > 0 ? { ...selection, sourceKeys } : null
  }, [breakdown, selection])

  const displayedChartSegments = useMemo<ChartSegment[]>(() => activeSelection
    ? [{
        key: 'selectedSeries',
        label: activeSelection.label,
        sourceKeys: new Set(activeSelection.sourceKeys),
      }]
    : chartSegments,
  [activeSelection, chartSegments])

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {}
    displayedChartSegments.forEach((segment, index) => {
      const colorIndex = activeSelection?.colorIndex ?? index
      config[segment.key] = {
        label: segment.label,
        theme: CHART_COLORS[colorIndex % CHART_COLORS.length],
      }
    })
    return config
  }, [activeSelection, displayedChartSegments])

  const chartData = useMemo(() => daily.map((day) => {
    const entry: Record<string, string | number> = {
      date: format(parseISO(day.date), 'MMM d'),
    }
    const source = segmentation === 'byModel'
      ? day.byModel.map((item) => ({
          key: item.model,
          value: metric === 'cost' ? item.cost : (item.totalTokens ?? 0),
        }))
      : day.byAgent.map((item) => ({
          key: item.agentSlug,
          value: metric === 'cost' ? item.cost : item.totalTokens,
        }))

    for (const segment of displayedChartSegments) {
      entry[segment.key] = source.reduce(
        (sum, item) => sum + (segment.sourceKeys.has(item.key) ? item.value : 0),
        0,
      )
    }
    return entry
  }), [daily, displayedChartSegments, metric, segmentation])

  const peakDay = useMemo(() => {
    if (!hasUsage) return undefined
    return daily.reduce((peak, day) => day.totalCost > peak.totalCost ? day : peak, daily[0])
  }, [daily, hasUsage])

  const uniqueAgents = useMemo(() => new Set(
    daily.flatMap((day) => day.byAgent.filter((agent) => agent.cost > 0 || agent.totalTokens > 0).map((agent) => agent.agentSlug)),
  ).size, [daily])

  const selectedDaily = useMemo(() => {
    if (!activeSelection) return []
    const selectedKeys = new Set(activeSelection.sourceKeys)
    return daily.map((day) => {
      const source = segmentation === 'byModel'
        ? day.byModel.map((item) => ({ key: item.model, cost: item.cost, totalTokens: item.totalTokens ?? 0 }))
        : day.byAgent.map((item) => ({ key: item.agentSlug, cost: item.cost, totalTokens: item.totalTokens }))
      return source.reduce(
        (totals, item) => selectedKeys.has(item.key)
          ? { cost: totals.cost + item.cost, totalTokens: totals.totalTokens + item.totalTokens }
          : totals,
        { cost: 0, totalTokens: 0 },
      )
    })
  }, [activeSelection, daily, segmentation])

  const selectedTotalCost = selectedDaily.reduce((sum, day) => sum + day.cost, 0)
  const selectedTotalTokens = selectedDaily.reduce((sum, day) => sum + day.totalTokens, 0)
  const selectedActiveDays = selectedDaily.filter((day) => day.cost > 0 || day.totalTokens > 0).length
  const selectedPeakSpend = selectedDaily.reduce((peak, day) => Math.max(peak, day.cost), 0)
  const selectedColor = activeSelection
    ? CHART_COLORS[activeSelection.colorIndex % CHART_COLORS.length].light
    : undefined

  const toggleSelection = (next: UsageSelection) => {
    setSelection((current) => {
      if (!current || current.sourceKeys.length !== next.sourceKeys.length) return next
      const currentKeys = new Set(current.sourceKeys)
      return next.sourceKeys.every((key) => currentKeys.has(key)) ? null : next
    })
  }

  const changeSegmentation = (next: Segmentation) => {
    setSelection(null)
    setSegmentation(next)
  }

  const changeMetric = (next: Metric) => {
    setSelection(null)
    setMetric(next)
  }

  const providerUsageLink = settings?.llmProvider
    ? PROVIDER_USAGE_LINKS[settings.llmProvider]
    : undefined

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-6 pb-8">
      <div>
        <h2 className="mb-8 hidden text-xl font-medium md:block">Usage</h2>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Estimated model usage across {isAuthMode && !globalView ? 'your agents' : 'all agents'}.
            </p>
            {dateRange && (
              <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                {dateRange}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isAuthMode && isAdmin && (
              <Select
                value={globalView ? 'global' : 'mine'}
                onValueChange={(value) => {
                  setSelection(null)
                  setGlobalView(value === 'global')
                }}
              >
                <SelectTrigger className="h-8 w-[130px] bg-background text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mine">My agents</SelectItem>
                  <SelectItem value="global">All agents</SelectItem>
                </SelectContent>
              </Select>
            )}

            <div className="flex h-8 items-center rounded-md border bg-muted/40 p-0.5" aria-label="Usage period">
              {DAY_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  className={cn(
                    'h-7 rounded px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    days === option && 'bg-background text-foreground shadow-sm',
                  )}
                  aria-pressed={days === option}
                  onClick={() => {
                    setSelection(null)
                    setDays(option)
                  }}
                >
                  {option}d
                </button>
              ))}
            </div>

            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 text-xs"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {isLoading || (isFetching && !data) ? (
        <UsageSkeleton />
      ) : !hasUsage ? (
        <div className="flex min-h-[360px] flex-col items-center justify-center rounded-xl border bg-card/50 px-6 text-center">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-muted">
            <Gauge className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-medium">No usage in this period</h3>
          <p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">
            Model activity will appear here after an agent completes a request.
          </p>
        </div>
      ) : (
        <>
          <section className="overflow-hidden rounded-xl border bg-card/70 shadow-sm" aria-labelledby="usage-overview-heading">
            <div className="flex flex-col gap-5 border-b px-5 py-5 sm:px-6 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">Estimated spend</p>
                <div className="mt-1.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 id="usage-overview-heading" className="text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl">
                    {activeSelection && selectedColor ? (
                      <MetricFraction
                        selected={formatCurrency(selectedTotalCost)}
                        total={formatCurrency(totalCost)}
                        accent={selectedColor}
                      />
                    ) : formatCurrency(totalCost)}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {formatCurrency(
                      (activeSelection ? selectedTotalCost : totalCost) /
                      Math.max(activeSelection ? selectedActiveDays : activeDays, 1),
                    )} per active day
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Select value={segmentation} onValueChange={(value) => changeSegmentation(value as Segmentation)}>
                  <SelectTrigger className="h-8 w-[126px] bg-background text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="byModel">By model</SelectItem>
                    <SelectItem value="byAgent">By agent</SelectItem>
                  </SelectContent>
                </Select>
                <MetricToggle metric={metric} onChange={changeMetric} />
              </div>
            </div>

            <div className="px-2 pb-3 pt-5 sm:px-5">
              <ChartContainer config={chartConfig} className="h-[235px] w-full aspect-auto">
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                  <defs>
                    {displayedChartSegments.map((segment, index) => (
                      <linearGradient key={segment.key} id={`usage-fill-${index}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={`var(--color-${segment.key})`} stopOpacity={0.42} />
                        <stop offset="100%" stopColor={`var(--color-${segment.key})`} stopOpacity={0.04} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 4" />
                  <XAxis
                    dataKey="date"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={10}
                    interval={days > 14 ? 4 : days > 7 ? 2 : 'preserveStartEnd'}
                    minTickGap={18}
                  />
                  <YAxis
                    width={52}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => metric === 'cost' ? formatCurrency(value, true) : formatCompactNumber(value)}
                  />
                  <ChartTooltip
                    content={(
                      <ChartTooltipContent
                        indicator="line"
                        valueFormatter={(value) => metric === 'cost' ? formatCurrency(value) : `${formatCompactNumber(value)} tokens`}
                      />
                    )}
                  />
                  {displayedChartSegments.map((segment, index) => (
                    <Area
                      key={segment.key}
                      type="monotone"
                      dataKey={segment.key}
                      stackId="usage"
                      stroke={`var(--color-${segment.key})`}
                      strokeWidth={2}
                      fill={`url(#usage-fill-${index})`}
                      fillOpacity={1}
                      activeDot={{ r: 3, strokeWidth: 0 }}
                    />
                  ))}
                </AreaChart>
              </ChartContainer>
              <ChartSeriesLegend
                segments={chartSegments}
                selection={activeSelection}
                onSelect={toggleSelection}
              />
            </div>

            <div className="grid border-t sm:grid-cols-2 xl:grid-cols-4">
              <SummaryStat
                label="Processed tokens"
                value={formatCompactNumber(totalTokens)}
                selectedValue={activeSelection ? formatCompactNumber(selectedTotalTokens) : undefined}
                accent={selectedColor}
                detail={activeSelection
                  ? `${formatCompactNumber(selectedTotalTokens / Math.max(selectedActiveDays, 1))} selected per active day`
                  : `${formatCompactNumber(totalTokens / Math.max(activeDays, 1))} per active day`}
              />
              <SummaryStat
                label="Active days"
                value={`${activeDays}`}
                selectedValue={activeSelection ? `${selectedActiveDays}` : undefined}
                accent={selectedColor}
                detail={activeSelection ? `of ${activeDays} total active days` : `of ${daily.length} days observed`}
              />
              <SummaryStat
                label="Peak spend"
                value={formatCurrency(peakDay?.totalCost ?? 0)}
                selectedValue={activeSelection ? formatCurrency(selectedPeakSpend) : undefined}
                accent={selectedColor}
                detail={activeSelection
                  ? `${activeSelection.label} peak / overall peak`
                  : peakDay ? format(parseISO(peakDay.date), 'EEEE, MMM d') : '—'}
              />
              <SummaryStat
                label={segmentation === 'byModel' ? 'Models in view' : 'Active agents'}
                value={`${segmentation === 'byModel' ? breakdown.length : uniqueAgents}`}
                selectedValue={activeSelection ? `${activeSelection.sourceKeys.length}` : undefined}
                accent={selectedColor}
                detail={activeSelection
                  ? `${activeSelection.label} selected`
                  : `${breakdown.length} ${segmentation === 'byModel' ? 'models' : 'agents'} in this view`}
              />
            </div>
          </section>

          <section className="overflow-hidden rounded-xl border bg-card/70" aria-labelledby="usage-breakdown-heading">
            <div className="flex flex-col gap-3 border-b px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
              <div>
                <h3 id="usage-breakdown-heading" className="text-sm font-medium">Breakdown</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Click a row or chart legend item to isolate it. Ranked by estimated cost.
                </p>
              </div>
              <div className="flex rounded-md bg-muted p-0.5">
                <BreakdownButton active={segmentation === 'byModel'} onClick={() => changeSegmentation('byModel')}>
                  Model
                </BreakdownButton>
                <BreakdownButton active={segmentation === 'byAgent'} onClick={() => changeSegmentation('byAgent')}>
                  Agent
                </BreakdownButton>
              </div>
            </div>

            <div className="overflow-x-auto">
              <div className="min-w-[620px]">
                <div className="grid grid-cols-[minmax(220px,1fr)_110px_160px_110px] gap-5 border-b px-5 py-2.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground sm:px-6">
                  <span>{segmentation === 'byModel' ? 'Model' : 'Agent'}</span>
                  <span className="text-right">Tokens</span>
                  <span>Share</span>
                  <span className="text-right">Cost</span>
                </div>
                {breakdown.map((row) => {
                  const share = totalCost > 0 ? (row.cost / totalCost) * 100 : 0
                  const segmentIndex = chartSegments.findIndex((segment) => segment.sourceKeys.has(row.key))
                  const colorIndex = Math.max(segmentIndex, 0)
                  const color = CHART_COLORS[colorIndex % CHART_COLORS.length]
                  const isIncluded = activeSelection?.sourceKeys.includes(row.key) ?? false
                  return (
                    <button
                      key={row.key}
                      type="button"
                      className={cn(
                        'grid w-full grid-cols-[minmax(220px,1fr)_110px_160px_110px] items-center gap-5 border-b px-5 py-3 text-left transition-colors last:border-b-0 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6',
                        isIncluded && 'bg-muted/60',
                      )}
                      aria-pressed={isIncluded}
                      onClick={() => toggleSelection({
                        key: `item:${row.key}`,
                        label: row.label,
                        sourceKeys: [row.key],
                        colorIndex,
                      })}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                          style={{
                            color: color.light,
                            backgroundColor: `color-mix(in srgb, ${color.light} 12%, transparent)`,
                          }}
                        >
                          {segmentation === 'byModel'
                            ? <UsageProviderIcon model={row.key} />
                            : <Bot className="h-3.5 w-3.5" aria-hidden="true" />}
                        </div>
                        <span className="truncate text-sm font-medium" title={row.label}>{row.label}</span>
                      </div>
                      <span className="text-right text-sm tabular-nums text-muted-foreground">
                        {formatCompactNumber(row.totalTokens)}
                      </span>
                      <div className="flex items-center gap-2.5">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full rounded-full"
                            style={{ width: `${Math.max(share, share > 0 ? 1.5 : 0)}%`, backgroundColor: color.light }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{share.toFixed(1)}%</span>
                      </div>
                      <span className="text-right text-sm font-medium tabular-nums">{formatCurrency(row.cost)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>
        </>
      )}

      <Alert className="border-amber-500/25 bg-amber-500/[0.04] py-3">
        <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
        <AlertTitle className="text-xs font-medium">Usage and cost estimates may be incomplete</AlertTitle>
        <AlertDescription className="text-xs leading-5 text-muted-foreground">
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
    </div>
  )
}

function MetricToggle({ metric, onChange }: { metric: Metric; onChange: (metric: Metric) => void }) {
  return (
    <div className="flex h-8 items-center rounded-md bg-muted p-0.5" aria-label="Chart metric">
      {(['cost', 'tokens'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={cn(
            'h-7 rounded px-2.5 text-xs font-medium capitalize text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            metric === option && 'bg-background text-foreground shadow-sm',
          )}
          aria-pressed={metric === option}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function ChartSeriesLegend({
  segments,
  selection,
  onSelect,
}: {
  segments: ChartSegment[]
  selection: UsageSelection | null
  onSelect: (selection: UsageSelection) => void
}) {
  const selectedKeys = new Set(selection?.sourceKeys ?? [])
  return (
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 px-3 pb-1 pt-3" aria-label="Filter chart series">
      {segments.map((segment, index) => {
        const color = CHART_COLORS[index % CHART_COLORS.length]
        const isActive = segment.sourceKeys.size === selectedKeys.size &&
          Array.from(segment.sourceKeys).every((key) => selectedKeys.has(key))
        return (
          <button
            key={segment.key}
            type="button"
            className={cn(
              'flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive && 'bg-muted text-foreground',
            )}
            aria-pressed={isActive}
            onClick={() => onSelect({
              key: `legend:${segment.key}`,
              label: segment.label,
              sourceKeys: Array.from(segment.sourceKeys),
              colorIndex: index,
            })}
          >
            <span className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: color.light }} aria-hidden="true" />
            <span>{segment.label}</span>
          </button>
        )
      })}
    </div>
  )
}

function MetricFraction({ selected, total, accent }: { selected: string; total: string; accent: string }) {
  return (
    <>
      <span style={{ color: accent }}>{selected}</span>
      <span className="font-normal text-muted-foreground"> / {total}</span>
    </>
  )
}

function UsageProviderIcon({ model }: { model: string }) {
  const provider = modelProviderIcon(model)
  if (!provider) {
    return <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
  }

  const iconUrl = `${import.meta.env.BASE_URL}model-icons/${provider}.svg`
  return (
    <span
      className="h-3.5 w-3.5 bg-current"
      style={{
        WebkitMaskImage: `url("${iconUrl}")`,
        WebkitMaskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
        maskImage: `url("${iconUrl}")`,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain',
      }}
      data-provider-icon={provider}
      aria-hidden="true"
    />
  )
}

function BreakdownButton({
  active,
  children,
  onClick,
}: {
  active: boolean
  children: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'h-7 rounded px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active && 'bg-background text-foreground shadow-sm',
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function SummaryStat({
  label,
  value,
  selectedValue,
  accent,
  detail,
}: {
  label: string
  value: string
  selectedValue?: string
  accent?: string
  detail: string
}) {
  return (
    <div className="border-t px-5 py-4 first:border-t-0 sm:border-t sm:px-6 sm:even:border-l sm:[&:nth-child(-n+2)]:border-t-0 xl:border-l xl:border-t-0 xl:first:border-l-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-medium tabular-nums">
        {selectedValue && accent
          ? <MetricFraction selected={selectedValue} total={value} accent={accent} />
          : value}
      </p>
      <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{detail}</p>
    </div>
  )
}

function UsageSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card/70" role="status" aria-label="Loading usage data">
      <div className="flex items-start justify-between border-b p-6">
        <div className="space-y-3">
          <div className="h-3 w-24 animate-pulse rounded bg-muted" />
          <div className="h-9 w-40 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-8 w-52 animate-pulse rounded bg-muted" />
      </div>
      <div className="h-[320px] animate-pulse bg-gradient-to-b from-muted/20 to-muted/60" />
      <div className="grid grid-cols-2 border-t xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="space-y-2 border-l p-5 first:border-l-0">
            <div className="h-3 w-20 animate-pulse rounded bg-muted" />
            <div className="h-6 w-24 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
