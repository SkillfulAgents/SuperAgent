import { describe, expect, it } from 'vitest'
import type { ApiMessageOrBoundary } from '@shared/lib/types/api'
import { INVOKE_AGENT_TOOL, collectAgentCalls, currentTurnStart, findCalledAgent } from './agent-calls'

const invoke = (id: string, input: Record<string, unknown>, result?: string, isError = false) => ({
  id, name: INVOKE_AGENT_TOOL, input, result, isError,
})
const assistant = (id: string, toolCalls: unknown[]) =>
  ({ type: 'assistant', id, content: { text: '' }, toolCalls, createdAt: new Date() }) as unknown as ApiMessageOrBoundary
const user = (id: string, queued = false) =>
  ({ type: 'user', id, content: { text: 'hi' }, toolCalls: [], createdAt: new Date(), queued }) as unknown as ApiMessageOrBoundary

describe('collectAgentCalls', () => {
  it('lists each called session once, newest first, at its latest prompt', () => {
    const messages = [
      assistant('a1', [invoke('t1', { slug: 'researcher', prompt: 'Find facts' }, 'session_id: s1\nstatus: running')]),
      assistant('a2', [invoke('t2', { slug: 'writer', prompt: 'Draft it' }, 'session_id: s2\nstatus: idle')]),
      assistant('a3', [invoke('t3', { slug: 'researcher', session_id: 's1', prompt: '  More facts ' }, 'session_id: s1\nstatus: running')]),
    ]
    expect(collectAgentCalls(messages, 'me').map(c => [c.slug, c.sessionId, c.prompt, c.reportedStatus])).toEqual([
      ['researcher', 's1', 'More facts', 'running'],
      ['writer', 's2', 'Draft it', 'idle'],
    ])
  })

  it('keeps a call still waiting for its session, and drops a failed one', () => {
    const messages = [
      assistant('a1', [
        invoke('t1', { prompt: 'Ask myself' }),
        invoke('t2', { slug: 'x', prompt: 'Broken' }, 'Error: no such agent', true),
      ]),
    ]
    expect(collectAgentCalls(messages, 'me')).toEqual([
      { key: 'pending:t1', slug: 'me', sessionId: null, prompt: 'Ask myself', pending: true, reportedStatus: null },
    ])
  })

  it('reads only from the turn start it is given', () => {
    const messages = [
      user('u1'),
      assistant('a1', [invoke('t1', { slug: 'old', prompt: 'Earlier' }, 'session_id: s0\nstatus: idle')]),
      user('u2'),
      user('u3', true),
      assistant('a2', [invoke('t2', { slug: 'new', prompt: 'Now' }, 'session_id: s1\nstatus: running')]),
    ]
    const start = currentTurnStart(messages)
    expect(start).toBe(2)
    expect(collectAgentCalls(messages, 'me', start).map(c => c.slug)).toEqual(['new'])
  })
})

describe('findCalledAgent', () => {
  const agents = [{ slug: '83tkvj492h', displaySlug: 'business-bot-83tkvj492h', name: 'Business Bot' }]
  it('finds an agent named by its id, its readable slug, or a stale one', () => {
    expect(findCalledAgent('83tkvj492h', agents)?.name).toBe('Business Bot')
    expect(findCalledAgent('business-bot-83tkvj492h', agents)?.name).toBe('Business Bot')
    expect(findCalledAgent('old-name-83tkvj492h', agents)?.name).toBe('Business Bot')
    expect(findCalledAgent('someone-else', agents)).toBeUndefined()
  })
})
