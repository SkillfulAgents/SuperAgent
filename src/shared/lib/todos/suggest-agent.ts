import { decide } from '@shared/lib/decision'
import type { SuggestTodoAgentInput } from './todo-schema'

/** Only the most recently used agents are offered, to keep the request inside every provider's limits. */
export const SUGGEST_AGENT_MAX_OPTIONS = 20
const DESCRIPTION_MAX_CHARS = 200

export interface AgentCandidate {
  slug: string
  name: string
  description?: string
  lastActivityAt: Date | null
}

export interface AgentSuggestion {
  agentSlug: string
}

/**
 * The agent the decision model ranks first for this todo, or null when the call fails.
 * The top pick is taken whatever its probability: providers scale probabilities
 * differently, and the person confirms the pick before it starts.
 */
export async function suggestTodoAgent(
  todo: SuggestTodoAgentInput,
  agents: AgentCandidate[],
): Promise<AgentSuggestion | null> {
  const shortlist = [...agents]
    .sort((a, b) => (b.lastActivityAt?.getTime() ?? 0) - (a.lastActivityAt?.getTime() ?? 0))
    .slice(0, SUGGEST_AGENT_MAX_OPTIONS)
  if (shortlist.length === 0) return null
  const options = Object.fromEntries(shortlist.map((agent) => [agent.slug, describe(agent)]))
  try {
    const { agent } = await decide({
      state: { todo: { title: todo.title, description: todo.description } },
      questions: {
        agent: { type: 'choice', instructions: 'Which agent is best suited to help with this task?', options },
      },
    })
    if (agent?.type !== 'choice' || !Object.hasOwn(options, agent.choice)) return null
    return { agentSlug: agent.choice }
  } catch (error) {
    console.warn('[todos] Agent suggestion failed:', error instanceof Error ? error.message : error)
    return null
  }
}

function describe(agent: AgentCandidate): string {
  const description = agent.description?.trim().slice(0, DESCRIPTION_MAX_CHARS)
  return description ? `${agent.name}: ${description}` : agent.name
}
