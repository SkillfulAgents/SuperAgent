import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '@shared/lib/decision'

const model = vi.hoisted(() => ({
  requests: [] as DecisionRequest[],
  answer: async (): Promise<DecisionResult> => ({}),
}))
vi.mock('@shared/lib/decision', () => ({
  decide: (request: DecisionRequest) => {
    model.requests.push(request)
    return model.answer()
  },
}))

import { SUGGEST_AGENT_MAX_OPTIONS, suggestTodoAgent, type AgentCandidate } from './suggest-agent'

const todo = { title: 'Reply to the Acme invoice email', description: '' }
const agents: AgentCandidate[] = [
  { slug: 'email-triage', name: 'Email Triage', description: 'Sorts the inbox', lastActivityAt: new Date('2026-10-12') },
  { slug: 'finance-bot', name: 'Finance Bot', description: 'Pays and files invoices', lastActivityAt: new Date('2026-10-11') },
  { slug: 'web-researcher', name: 'Web Researcher', lastActivityAt: null },
]

function picks(choice: string, confidence: number) {
  model.answer = async () => ({ agent: { type: 'choice', choice, confidence, probabilities: { [choice]: confidence } } })
}

function offered(): Record<string, string> {
  const question = model.requests[0].questions.agent
  if (question.type !== 'choice') throw new Error('expected a choice question')
  return question.options
}

beforeEach(() => {
  model.requests = []
})

describe('suggestTodoAgent', () => {
  it('asks one choice question over the agents and returns the top pick', async () => {
    picks('finance-bot', 0.81)
    expect(await suggestTodoAgent(todo, agents)).toEqual({ agentSlug: 'finance-bot' })
    expect(model.requests[0].state).toEqual({ todo })
    expect(offered()).toEqual({
      'email-triage': 'Email Triage: Sorts the inbox',
      'finance-bot': 'Finance Bot: Pays and files invoices',
      'web-researcher': 'Web Researcher',
    })
  })

  it('offers only the most recently used agents, with short descriptions', async () => {
    picks('agent-0', 0.9)
    const many = Array.from({ length: 30 }, (_, i) => ({
      slug: `agent-${i}`,
      name: `Agent ${i}`,
      description: 'x'.repeat(500),
      lastActivityAt: new Date(Date.UTC(2026, 9, 1) - i * 60_000),
    }))
    await suggestTodoAgent(todo, [...many].reverse())
    const options = offered()
    expect(Object.keys(options)).toEqual(many.slice(0, SUGGEST_AGENT_MAX_OPTIONS).map((agent) => agent.slug))
    expect(options['agent-0']).toBe(`Agent 0: ${'x'.repeat(200)}`)
  })

  it('takes the top pick even when it barely wins', async () => {
    picks('finance-bot', 0.36)
    expect(await suggestTodoAgent(todo, agents)).toEqual({ agentSlug: 'finance-bot' })
  })

  it('suggests nothing when the model refuses or picks an agent not offered', async () => {
    model.answer = async () => ({ agent: { type: 'refused' } })
    expect(await suggestTodoAgent(todo, agents)).toBeNull()
    picks('someone-else', 0.95)
    expect(await suggestTodoAgent(todo, agents)).toBeNull()
  })

  it('suggests nothing when the decision call fails', async () => {
    model.answer = async () => { throw new Error('Decision request timed out') }
    expect(await suggestTodoAgent(todo, agents)).toBeNull()
  })

  it('does not ask when there are no agents', async () => {
    expect(await suggestTodoAgent(todo, [])).toBeNull()
    expect(model.requests).toEqual([])
  })
})
