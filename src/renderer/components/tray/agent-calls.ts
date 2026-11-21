import type { ApiAgent, ApiMessageOrBoundary } from '@shared/lib/types/api'
import { resolveRouteAgentId } from '@renderer/hooks/use-agents'
import { invokeAgentDef } from '@shared/lib/tools/x-agent-tools/definition'
import { isTurnStartingUserMessage } from '@renderer/components/messages/pending-message'

/** The tool by which a session asks another agent (or another session of its own agent) to work. */
export const INVOKE_AGENT_TOOL = 'mcp__agents__invoke_agent'

export interface AgentCallEntry {
  /** One row per called session, or per call still waiting for its session id. */
  key: string
  /** The called agent: the call's `slug`, or this session's own agent when it named none. */
  slug: string
  /** The session the call ran in; null while a waiting (`sync`) call has not returned it. */
  sessionId: string | null
  /** What this session last asked of it. */
  prompt: string
  /** The call has not returned yet. */
  pending: boolean
  /** The call's own reported status, `running` or the target's final state, when it returned one. */
  reportedStatus: string | null
}

/**
 * The conversations a session started or continued with other agents through
 * invoke_agent, most recent first, each called session once at its latest
 * message. `since` limits it to the messages from that index on (the current
 * turn, say). Failed calls are left out: no conversation came of them.
 */
export function collectAgentCalls(
  messages: ApiMessageOrBoundary[] | undefined,
  selfSlug: string,
  since = 0,
): AgentCallEntry[] {
  if (!messages) return []
  const byKey = new Map<string, AgentCallEntry>()
  for (let index = since; index < messages.length; index++) {
    const message = messages[index]
    if (message.type !== 'assistant' && message.type !== 'user') continue
    for (const call of message.toolCalls ?? []) {
      if (call.name !== INVOKE_AGENT_TOOL || call.isError) continue
      const input = invokeAgentDef.parseInput(call.input)
      const result = typeof call.result === 'string' ? call.result : ''
      const sessionId = result.match(/session_id:\s*(\S+)/)?.[1] ?? input.session_id ?? null
      const slug = input.slug ?? selfSlug
      const key = sessionId ? `${slug}:${sessionId}` : `pending:${call.id}`
      // Re-inserting moves the session to the end, which is the newest.
      byKey.delete(key)
      byKey.set(key, {
        key,
        slug,
        sessionId,
        prompt: (input.prompt ?? '').trim(),
        pending: call.result == null,
        reportedStatus: result.match(/status:\s*(\S+)/)?.[1] ?? null,
      })
    }
  }
  return [...byKey.values()].reverse()
}

/** Where the current turn begins: the last message a person sent that started one. */
export function currentTurnStart(messages: ApiMessageOrBoundary[] | undefined): number {
  if (!messages) return 0
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isTurnStartingUserMessage(messages[index])) return index
  }
  return 0
}

/**
 * The agent a call named. An agent may name another by its readable slug
 * (`business-bot-83tkvj492h`) as well as its id, or by one that has since gone
 * stale, so match the way a route does.
 */
export function findCalledAgent<T extends Pick<ApiAgent, 'slug' | 'displaySlug'>>(slug: string, agents: T[] | undefined): T | undefined {
  const id = resolveRouteAgentId(slug, agents)
  return agents?.find(agent => agent.slug === id)
}
