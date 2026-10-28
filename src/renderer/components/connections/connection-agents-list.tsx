import { useAgents } from '@renderer/hooks/use-agents'
import { useUser } from '@renderer/context/user-context'
import { AgentAssignmentList } from '@renderer/components/agents/agent-assignment-list'
import { useAccountAgents, useAssignAccountsToAgent, useRemoveAgentConnectedAccount } from '@renderer/hooks/use-connected-accounts'
import { useMcpAgents, useAssignMcpToAgent, useRemoveMcpFromAgent } from '@renderer/hooks/use-remote-mcps'

interface ConnectionAgentsListProps {
  type: 'oauth' | 'mcp'
  id: string
  name: string
  sectioned?: boolean
}

export function ConnectionAgentsList({ type, id, name, sectioned = false }: ConnectionAgentsListProps) {
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const agents = useAgents()
  const accountAgents = useAccountAgents(type === 'oauth' ? id : '')
  const mcpAgents = useMcpAgents(type === 'mcp' ? id : '')
  const assignment = type === 'oauth' ? accountAgents : mcpAgents
  const assignAccount = useAssignAccountsToAgent()
  const removeAccount = useRemoveAgentConnectedAccount()
  const assignMcp = useAssignMcpToAgent()
  const removeMcp = useRemoveMcpFromAgent()

  return <AgentAssignmentList
    agents={(agents.data ?? []).filter(agent => !isAuthMode || (rolesReady && canAdminAgent(agent.slug)))}
    assignedSlugs={assignment.data?.agentSlugs ?? []} sectioned={sectioned}
    isLoading={agents.isLoading || assignment.isLoading || (isAuthMode && !rolesReady)}
    error={agents.error ?? assignment.error}
    onToggle={async (slug, next) => {
      if (type === 'oauth') {
        if (next) await assignAccount.mutateAsync({ agentSlug: slug, accountIds: [id] })
        else await removeAccount.mutateAsync({ agentSlug: slug, accountId: id })
      } else {
        if (next) await assignMcp.mutateAsync({ agentSlug: slug, mcpIds: [id] })
        else await removeMcp.mutateAsync({ agentSlug: slug, mcpId: id })
      }
    }}
    toggleLabel={(agent, assigned) => `${assigned ? 'Revoke' : 'Grant'} ${name} access for ${agent.name}`}
    testId={slug => `connection-agent-toggle-${type}-${id}-${slug}`}
  />
}
