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
