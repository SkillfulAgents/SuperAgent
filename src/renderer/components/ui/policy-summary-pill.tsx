import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { CircleCheck, Hand, Ban, Shield, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@renderer/components/ui/tooltip'
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
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
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
              compact && 'border-transparent bg-transparent text-emerald-600 dark:text-emerald-400',
              !hasAnyPolicy && (compact ? 'py-px gap-1.5' : 'px-2 py-0.5 gap-1 text-muted-foreground')
            )}
          >
            {compact ? (
              hasAnyPolicy ? (
                <>
                  <Shield className="h-3.5 w-3.5 text-current" />
                  <span>Protected • Custom</span>
                  <ChevronDown className="h-3.5 w-3.5 text-current" />
                </>
              ) : (
                <>
                  <Shield className="h-3.5 w-3.5 text-current" />
                  <span>Protected</span>
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
                        'flex items-center gap-1 px-1.5 py-0.5',
                        seg.bgColor
                      )}
                    >
                      <seg.icon className={cn('h-3 w-3', seg.color)} />
                      <span className={cn('font-medium tabular-nums', seg.color)}>{seg.count}</span>
                    </div>
                  ))
                ) : accountDefault ? (
                  (() => {
                    const seg = segments.find((s) => s.decision === accountDefault.decision)!
                    return (
                      <div className={cn(
                        'flex items-center gap-1 px-1.5 py-0.5',
                        seg.bgColor
                      )}>
                        <seg.icon className={cn('h-3 w-3', seg.color)} />
                        <span className={cn('font-medium', seg.color)}>All</span>
                      </div>
                    )
                  })()
                ) : (
                  <span>Protected</span>
                )
              ) : (
                <span>Protected</span>
              )
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          <div className="space-y-1.5 text-xs">
            <div className="font-medium border-b border-border/50 pb-1">Scope Policies</div>
            {segments.map((seg) =>
              seg.count > 0 ? (
                <div key={seg.decision} className="flex items-center gap-1.5">
                  <seg.icon className={cn('h-3 w-3', seg.color)} />
                  <span>{decisionLabel[seg.decision]}: {seg.count} scope{seg.count !== 1 ? 's' : ''}</span>
                </div>
              ) : null
            )}
            {defaultCount > 0 && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span className="h-3 w-3 flex items-center justify-center">-</span>
                <span>Default: {defaultCount} scope{defaultCount !== 1 ? 's' : ''}</span>
              </div>
            )}
            {accountDefault && (
              <div className="border-t border-border/50 pt-1 text-muted-foreground">
                Account default: <span className="capitalize">{accountDefault.decision}</span>
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
