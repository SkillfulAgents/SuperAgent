import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Shield, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { isLabelDefaultKey, LABEL_DEFAULT_BASELINE } from '@shared/lib/proxy/policy-sentinels'
import type { ScopeLabel } from '@shared/lib/proxy/scope-metadata'

interface PolicySummaryPillProps {
  accountId: string
  onClick?: () => void
}

interface PolicyData {
  policies: Array<{ scope: string; decision: 'allow' | 'review' | 'block' }>
}

export function PolicySummaryPill({ accountId, onClick }: PolicySummaryPillProps) {
  const { data } = useQuery<PolicyData>({
    queryKey: ['scope-policies', accountId],
    queryFn: async () => {
      const res = await apiFetch(`/api/policies/scope/${accountId}`)
      if (!res.ok) throw new Error('Failed to fetch policies')
      return res.json()
    },
  })

  // The scope editor pre-fills the recommended per-label baseline ('*read'=allow,
  // '*write'=review, '*destructive'=block) and persists it on Save. Saving the
  // baseline as-is is not a meaningful customization, so only count policies that
  // DEVIATE from that baseline when deciding whether to show "Custom".
  const customPolicies = (data?.policies ?? []).filter((p) => {
    if (isLabelDefaultKey(p.scope)) {
      return LABEL_DEFAULT_BASELINE[p.scope.slice(1) as ScopeLabel] !== p.decision
    }
    return true
  })
  const hasAnyPolicy = customPolicies.length > 0

  return (
    <button
      type="button"
      data-testid={`policy-pill-${accountId}`}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 overflow-hidden border border-transparent bg-transparent px-1.5 py-px text-xs transition-colors hover:opacity-80',
        'rounded-[6px]',
        'text-emerald-600 dark:text-emerald-400',
      )}
    >
      <Shield className="h-3.5 w-3.5 text-current" />
      <span>{hasAnyPolicy ? 'Protected • Custom' : 'Protected'}</span>
      <ChevronDown className="h-3.5 w-3.5 text-current" />
    </button>
  )
}
