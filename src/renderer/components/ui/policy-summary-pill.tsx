import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Shield, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

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

  const hasAnyPolicy = (data?.policies?.length || 0) > 0

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
