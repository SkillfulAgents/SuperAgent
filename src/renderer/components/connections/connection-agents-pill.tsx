import { Users, ChevronDown } from 'lucide-react'
import { cn } from '@shared/lib/utils/cn'
import { useAccountAgents } from '@renderer/hooks/use-connected-accounts'
import { useMcpAgents } from '@renderer/hooks/use-remote-mcps'

interface ConnectionAgentsPillProps {
  type: 'oauth' | 'mcp'
  id: string
  onClick?: () => void
}

export function ConnectionAgentsPill({ type, id, onClick }: ConnectionAgentsPillProps) {
  const accountAgents = useAccountAgents(type === 'oauth' ? id : '')
  const mcpAgents = useMcpAgents(type === 'mcp' ? id : '')
  const data = type === 'oauth' ? accountAgents.data : mcpAgents.data
  const count = data?.agentSlugs.length ?? 0

  return (
    <button
      type="button"
      data-testid={`connection-agents-pill-${type}-${id}`}
      onClick={(e) => {
        e.stopPropagation()
        onClick?.()
      }}
      className={cn(
        'inline-flex items-center gap-1.5 overflow-hidden border border-transparent bg-transparent px-1.5 py-px text-xs transition-colors hover:opacity-80',
        'rounded-[6px]',
        count > 0 ? 'text-foreground' : 'text-muted-foreground',
      )}
    >
      <Users className="h-3.5 w-3.5 text-current" />
      <span className="tabular-nums">
        {count} {count === 1 ? 'agent' : 'agents'}
      </span>
      <ChevronDown className="h-3.5 w-3.5 text-current" />
    </button>
  )
}
