import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useAgents } from '@renderer/hooks/use-agents'
import { sessionQuery } from '@renderer/hooks/query-options'
import { collectAgentCalls, currentTurnStart, findCalledAgent } from '@renderer/components/tray/agent-calls'
import type { ActivityAgentCall } from '@renderer/components/messages/activity-card'
import type { ApiMessageOrBoundary, ApiSession } from '@shared/lib/types/api'

/**
 * The other agents the current turn asked to work, each working for as long as
 * its own session is: an invoke_agent call returns at once unless it waited
 * (sync), so the call alone does not say whether the agent is still at it.
 */
export function useTurnAgentCalls(messages: ApiMessageOrBoundary[] | undefined, agentSlug: string): ActivityAgentCall[] {
  const { data: agents } = useAgents()
  const calls = useMemo(
    () => collectAgentCalls(messages, agentSlug, currentTurnStart(messages)),
    [messages, agentSlug],
  )
  const sessions = useQueries({
    queries: calls.map((call) => ({
      ...sessionQuery(call.slug, call.sessionId ?? ''),
      enabled: !!call.sessionId,
    })),
  })
  return calls.map((call, index) => {
    const session = sessions[index]?.data as ApiSession | undefined
    const agent = findCalledAgent(call.slug, agents)
    const running = call.pending || (session ? !!session.isActive : call.reportedStatus === 'running')
    return {
      key: call.key,
      name: agent?.name ?? call.slug,
      // The slug rides on the agent so the row can open before the agent list has loaded.
      agent: agent ?? { slug: call.slug, avatar: undefined },
      prompt: call.prompt,
      status: running ? 'running' : 'completed',
      sessionId: call.sessionId,
    }
  })
}
