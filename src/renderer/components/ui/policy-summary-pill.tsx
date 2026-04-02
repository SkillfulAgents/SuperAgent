import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { CircleCheck, Hand, Ban, Shield, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { SCOPE_MAPS } from '@shared/lib/proxy/scope-maps'

type PolicyDecision = 'allow' | 'review' | 'block'

interface PolicySummaryPillProps {
  accountId: string
  toolkit: string
  onClick?: () => void
  compact?: boolean
}

interface PolicyData {
  policies: Array<{ scope: string; decision: PolicyDecision }>
}

export function PolicySummaryPill({ accountId, toolkit, onClick, compact = false }: PolicySummaryPillProps) {
  const { data } = useQuery<PolicyData>({
    queryKey: ['scope-policies', accountId],
    queryFn: async () => {
      const res = await apiFetch(`/api/policies/scope/${accountId}`)
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
  })

  const policies = data?.policies || []

  // Count by decision (excluding wildcard '*' which is the account default)
  const scopePolicies = policies.filter((p) => p.scope !== '*')
  const accountDefault = policies.find((p) => p.scope === '*')

  const counts: Record<PolicyDecision, number> = { allow: 0, review: 0, block: 0 }
  for (const p of scopePolicies) {
    counts[p.decision]++
  }

  // Count total scopes and unassigned
  const provider = SCOPE_MAPS[toolkit]
  const allScopes = provider
    ? Array.isArray(provider.allScopes)
      ? provider.allScopes
      : Object.values(provider.allScopes).flat()
    : []
  const totalScopes = allScopes.length
  const assignedCount = counts.allow + counts.review + counts.block
  const defaultCount = totalScopes - assignedCount

  const segments: Array<{ decision: PolicyDecision; count: number; icon: typeof CircleCheck; color: string; bgColor: string }> = [
    { decision: 'allow', count: counts.allow, icon: CircleCheck, color: 'text-green-600', bgColor: 'bg-green-100 dark:bg-green-900/50' },
    { decision: 'review', count: counts.review, icon: Hand, color: 'text-blue-600', bgColor: 'bg-blue-100 dark:bg-blue-900/50' },
    { decision: 'block', count: counts.block, icon: Ban, color: 'text-orange-600', bgColor: 'bg-orange-100 dark:bg-orange-900/50' },
  ]

  const visibleSegments = segments.filter((s) => s.count > 0)
  const hasAnyPolicy = visibleSegments.length > 0 || accountDefault

  const decisionLabel: Record<string, string> = {
    allow: 'Allow',
    review: 'Review',
    block: 'Block',
  }

  return (
    <button
      type="button"
      data-testid={`policy-pill-${accountId}`}
      onClick={onClick}
      className={cn(
        'inline-flex items-center border text-xs transition-colors overflow-hidden bg-white dark:bg-background',
        'hover:opacity-80',
        compact ? 'rounded-[6px]' : 'rounded-full',
        compact ? 'text-[11px]' : 'text-xs',
        compact && 'gap-1.5 px-1.5',
        compact && hasAnyPolicy && 'border-transparent bg-transparent text-emerald-600 dark:text-emerald-400',
        compact && !hasAnyPolicy && 'border-transparent bg-transparent text-emerald-600 dark:text-emerald-400',
        !hasAnyPolicy && (compact ? 'py-px gap-1.5' : 'px-2 py-0.5 gap-1 text-muted-foreground')
      )}
    >
      {compact ? (
        hasAnyPolicy ? (
          <>
            <Shield className="h-3.5 w-3.5 text-current" />
            <span>Protected • User custom</span>
            <ChevronDown className="h-3.5 w-3.5 text-current" />
          </>
        ) : (
          <>
            <Shield className="h-3.5 w-3.5 text-current" />
            <span>Protected • Gamut default</span>
            <ChevronDown className="h-3.5 w-3.5 text-current" />
          </>
        )
      ) : (
        hasAnyPolicy ? (
          visibleSegments.length > 0 ? (
            visibleSegments.map((seg) => (
              <div
                key={seg.decision}
                className={cn(
                  'flex items-center gap-1',
                  compact ? 'px-1 py-px' : 'px-1.5 py-0.5',
                  compact ? 'bg-transparent' : seg.bgColor
                )}
              >
                <seg.icon className={cn(compact ? 'h-2.5 w-2.5' : 'h-3 w-3', seg.color)} />
                <span className={cn(compact ? 'font-normal tabular-nums' : 'font-medium tabular-nums', seg.color)}>{seg.count}</span>
              </div>
            ))
          ) : accountDefault ? (
            (() => {
              const seg = segments.find((s) => s.decision === accountDefault.decision)!
              return (
                <div className={cn(
                  'flex items-center gap-1',
                  compact ? 'px-1 py-px' : 'px-1.5 py-0.5',
                  compact ? 'bg-transparent' : seg.bgColor
                )}>
                  <seg.icon className={cn(compact ? 'h-2.5 w-2.5' : 'h-3 w-3', seg.color)} />
                  <span className={cn(compact ? 'font-normal' : 'font-medium', seg.color)}>All</span>
                </div>
              )
            })()
          ) : (
            <span>Protected • Gamut default</span>
          )
        ) : (
          <span>Protected • Gamut default</span>
        )
      )}
    </button>
  )
}
