import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@renderer/lib/api'
import { Shield, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'

type PolicyDecision = 'allow' | 'review' | 'block'

interface ToolPolicySummaryPillProps {
  mcpId: string
  onClick?: () => void
}

interface ToolPolicyData {
  policies: Array<{ toolName: string; decision: PolicyDecision }>
}

export function ToolPolicySummaryPill({ mcpId, onClick }: ToolPolicySummaryPillProps) {
  const { data } = useQuery<ToolPolicyData>({
    queryKey: ['tool-policies', mcpId],
    queryFn: async () => {
      const res = await apiFetch(`/api/policies/tool/${mcpId}`)
      if (!res.ok) throw new Error('Failed to fetch tool policies')
      return res.json()
    },
  })

  const hasAnyPolicy = (data?.policies?.length || 0) > 0

  return (
    <button
      type="button"
      data-testid={`tool-policy-pill-${mcpId}`}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 overflow-hidden border border-transparent bg-transparent px-1.5 py-px text-[11px] transition-colors hover:opacity-80',
        'rounded-[6px]',
        'text-emerald-600 dark:text-emerald-400'
      )}
    >
      <Shield className="h-3.5 w-3.5 text-current" />
      <span>{hasAnyPolicy ? 'Permissions • Custom' : 'Permissions • Default'}</span>
      <ChevronDown className="h-3.5 w-3.5 text-current" />
    </button>
  )
}
