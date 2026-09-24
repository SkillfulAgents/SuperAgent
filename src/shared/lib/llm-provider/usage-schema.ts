import { z } from 'zod'

const amount = z.number().finite()
export const providerUsageSchema = z.object({
  status: z.enum(['available', 'unsupported', 'unavailable']),
  observedAt: z.string(),
  limits: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('window'), id: z.string(), label: z.string(), usedPercent: amount.min(0), resetsAt: z.string().optional() }),
    z.object({ kind: z.literal('balance'), id: z.string(), label: z.string(), remaining: amount, unit: z.enum(['USD', 'credits']) }),
  ])),
})
export type ProviderUsage = z.infer<typeof providerUsageSchema>
export type UsageLimit = ProviderUsage['limits'][number]
export function usageSnapshot(limits: UsageLimit[]): ProviderUsage {
  return { status: limits.length ? 'available' : 'unavailable', observedAt: new Date().toISOString(), limits }
}

const optionalNumber = z.union([z.number(), z.string().trim().min(1)]).transform(Number).pipe(z.number().finite()).nullish().catch(undefined)
const percent = z.number().finite().min(0).nullish().catch(undefined)
const timestamp = z.string().refine(v => Number.isFinite(Date.parse(v))).nullish().catch(undefined)
const codexWindow = z.object({ used_percent: percent, limit_window_seconds: optionalNumber, reset_at: optionalNumber }).nullish().catch(undefined)
const codexRateLimit = z.object({ primary_window: codexWindow, secondary_window: codexWindow }).nullish().catch(undefined)
export const codexUsageSchema = z.object({
  rate_limit: codexRateLimit,
  code_review_rate_limit: codexRateLimit,
  additional_rate_limits: z.array(z.object({ limit_name: z.string().optional(), metered_feature: z.string().optional(), rate_limit: codexRateLimit })).nullish().catch(undefined),
  credits: z.object({ balance: optionalNumber, has_credits: z.boolean().optional(), unlimited: z.boolean().optional() }).nullish().catch(undefined),
})
export function parseCodexUsage(raw: unknown): ProviderUsage {
  const data = codexUsageSchema.parse(raw)
  const limits: UsageLimit[] = []
  const groups = [
    { id: 'codex', label: '', rate: data.rate_limit },
    { id: 'review', label: 'Code review', rate: data.code_review_rate_limit },
    ...(data.additional_rate_limits ?? []).map((r, i) => ({ id: `additional-${i}`, label: r.limit_name ?? r.metered_feature ?? 'Additional', rate: r.rate_limit })),
  ]
  for (const group of groups) {
    for (const [slot, window] of [['primary', group.rate?.primary_window], ['secondary', group.rate?.secondary_window]] as const) {
      if (window?.used_percent == null) continue
      const seconds = window.limit_window_seconds
      const duration = seconds && seconds > 0 ? usageWindowLabel(seconds) : slot === 'primary' ? 'Usage' : 'Secondary'
      const reset = window.reset_at == null ? undefined : new Date(window.reset_at * 1000)
      limits.push({ kind: 'window', id: `${group.id}-${slot}`, label: [group.label, duration].filter(Boolean).join(' · '), usedPercent: window.used_percent,
        ...(reset && Number.isFinite(reset.getTime()) ? { resetsAt: reset.toISOString() } : {}) })
    }
  }
  if (data.credits?.has_credits !== false && !data.credits?.unlimited && data.credits?.balance != null) limits.push({ kind: 'balance', id: 'credits', label: 'Credits', remaining: data.credits.balance, unit: 'credits' })
  return usageSnapshot(limits)
}

function usageWindowLabel(seconds: number): string {
  if (seconds === 604800) return 'Weekly'
  if (seconds === 86400) return 'Daily'
  if (seconds === 2592000) return 'Monthly'
  if (seconds % 86400 === 0) return `${seconds / 86400} days`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.max(1, Math.round(seconds / 60))}m`
}

const cents = z.object({ val: optionalNumber }).nullish().catch(undefined)
export const grokUsageSchema = z.object({ config: z.object({
  creditUsagePercent: percent, credit_usage_percent: percent,
  currentPeriod: z.object({ type: z.string().optional().catch(undefined), end: timestamp }).nullish().catch(undefined),
  current_period: z.object({ type: z.string().optional().catch(undefined), end: timestamp }).nullish().catch(undefined),
  billingPeriodEnd: timestamp, billing_period_end: timestamp,
  used: cents, monthlyLimit: cents, monthly_limit: cents,
  prepaidBalance: cents, prepaid_balance: cents,
}) })
export function parseGrokUsage(raw: unknown): ProviderUsage {
  const { config } = grokUsageSchema.parse(raw)
  const limits: UsageLimit[] = []
  const period = config.currentPeriod ?? config.current_period
  const total = (config.monthlyLimit ?? config.monthly_limit)?.val
  const used = config.used?.val
  // On-demand spending is not included subscription quota. Missing is not zero.
  const usedPercent = config.creditUsagePercent ?? config.credit_usage_percent ?? (used != null && used >= 0 && total != null && total > 0 ? used / total * 100 : undefined)
  if (usedPercent != null) limits.push({ kind: 'window', id: 'included', label: period?.type?.endsWith('WEEKLY') ? 'Weekly' : period?.type?.endsWith('MONTHLY') || total != null ? 'Monthly' : 'Included usage', usedPercent,
    resetsAt: period?.end ?? config.billingPeriodEnd ?? config.billing_period_end ?? undefined })
  const prepaid = (config.prepaidBalance ?? config.prepaid_balance)?.val
  if (prepaid != null) limits.push({ kind: 'balance', id: 'prepaid', label: 'Prepaid credits', remaining: prepaid / 100, unit: 'USD' })
  return usageSnapshot(limits)
}

const kimiWindow = z.object({ used_ratio: z.number().finite().min(0).nullish().catch(undefined), reset_time: timestamp }).nullish().catch(undefined)
export const kimiUsageSchema = z.object({ usages: z.object({
  limit_5h: kimiWindow, limit_7d: kimiWindow, limit_month_total: kimiWindow,
}).nullish().catch(undefined) })

export function parseKimiUsage(raw: unknown): ProviderUsage {
  const usages = kimiUsageSchema.parse(raw).usages
  const windows = [['5h', '5-hour', usages?.limit_5h], ['7d', 'Weekly', usages?.limit_7d], ['month', 'Monthly', usages?.limit_month_total]] as const
  const limits: UsageLimit[] = windows.flatMap(([id, label, window]): UsageLimit[] => window?.used_ratio == null ? []
    : [{ kind: 'window', id, label, usedPercent: window.used_ratio * 100, resetsAt: window.reset_time ?? undefined }])
  return usageSnapshot(limits)
}

const count = z.number().finite().nullish().catch(undefined)
const minimaxRemainSchema = z.object({
  model_name: z.string().min(1),
  start_time: count, end_time: count, weekly_end_time: count,
  current_interval_total_count: count, current_interval_usage_count: count, current_interval_status: count,
  current_weekly_total_count: count, current_weekly_usage_count: count, current_weekly_status: count,
})
export const minimaxUsageSchema = z.object({ model_remains: z.array(minimaxRemainSchema).nullish().catch(undefined) })

function epochIso(value: number | null | undefined): string | undefined {
  if (value == null || value <= 0) return undefined
  const ms = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined
  if (ms == null) return undefined
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
function spanSeconds(start: number | null | undefined, end: number | null | undefined): number | undefined {
  if (start == null || end == null || end <= start) return undefined
  const delta = end - start
  return delta > 1e6 ? delta / 1000 : delta
}
function minimaxWindowLabel(seconds: number | undefined, fallback: string): string {
  if (seconds == null) return fallback
  if (Math.abs(seconds - 18_000) < 120) return '5-hour'
  if (Math.abs(seconds - 604_800) < 120) return 'Weekly'
  if (seconds % 86_400 === 0) return seconds === 86_400 ? 'Daily' : `${seconds / 86_400} days`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return fallback
}

export function parseMinimaxUsage(raw: unknown): ProviderUsage {
  const remains = minimaxUsageSchema.parse(raw).model_remains ?? []
  const limits: UsageLimit[] = []
  remains.forEach((model, index) => {
    const unavailable = model.current_interval_status === 3 && model.current_weekly_status === 3
      && !(model.current_interval_total_count && model.current_interval_total_count > 0)
      && !(model.current_weekly_total_count && model.current_weekly_total_count > 0)
    if (unavailable) return
    const windows = [
      { id: 'interval', label: minimaxWindowLabel(spanSeconds(model.start_time, model.end_time), 'Usage'), usage: model.current_interval_usage_count, total: model.current_interval_total_count, status: model.current_interval_status, resetsAt: epochIso(model.end_time) },
      { id: 'weekly', label: 'Weekly', usage: model.current_weekly_usage_count, total: model.current_weekly_total_count, status: model.current_weekly_status, resetsAt: epochIso(model.weekly_end_time) },
    ]
    for (const window of windows) {
      if (window.status === 3 && !(window.total && window.total > 0)) continue
      if (window.usage == null || window.usage < 0 || window.total == null || window.total <= 0) continue
      limits.push({
        kind: 'window', id: `${index}-${window.id}`, label: `${model.model_name} · ${window.label}`,
        usedPercent: window.usage / window.total * 100, ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
      })
    }
  })
  return usageSnapshot(limits)
}
