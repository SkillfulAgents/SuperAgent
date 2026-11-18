import { beforeEach, describe, expect, it, vi } from 'vitest'

const actor = vi.hoisted(() => ({
  idle: 'idle' as 'idle' | 'timeout',
  order: [] as string[],
  delivered: [] as Array<{ sessionId: string; content: string }>,
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      sessions: {
        waitForIdle: async (sessionId: string, opts: { timeoutMs?: number }) => {
          actor.order.push(`wait ${sessionId} ${opts.timeoutMs}`)
          return actor.idle
        },
      },
      messages: {
        deliver: async (request: { sessionId: string; content: string }) => {
          actor.order.push(`deliver ${request.sessionId}`)
          actor.delivered.push({ sessionId: request.sessionId, content: request.content })
          return { status: 'sent', queued: false }
        },
      },
    }),
  },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/db', () => ({ db: {} }))
const asked = vi.hoisted(() => ({ first: true }))
vi.mock('./vault-service', () => ({
  markSignInMethodAsked: async () => {
    actor.order.push('mark')
    const first = asked.first
    asked.first = false
    return first
  },
}))

const { askForSignInMethod } = await import('./method-request')

const account = { id: 'acc-1', site: 'github.com', username: 'octocat', ownerId: null }

describe('askForSignInMethod', () => {
  beforeEach(() => {
    actor.idle = 'idle'
    actor.order = []
    actor.delivered = []
    asked.first = true
  })

  it('asks once the agent\'s turn has ended, as a message of its own, once per session', async () => {
    expect(await askForSignInMethod({ agentSlug: 'agent-a', sessionId: 's-1', account, from: 'card' })).toBe(true)
    expect(actor.order).toEqual(['wait s-1 1800000', 'mark', 'deliver s-1'])
    expect(actor.delivered[0].content).toMatch(/^From the sign-in form: once you are signed in, also add an authenticator app to my account octocat on github\.com/)

    expect(await askForSignInMethod({ agentSlug: 'agent-a', sessionId: 's-1', account, from: 'card' })).toBe(false)
    expect(actor.delivered).toHaveLength(1)
  })

  it('asks nothing in a session whose turn outlasts the wait: the request stays for the next sign-in', async () => {
    actor.idle = 'timeout'
    expect(await askForSignInMethod({ agentSlug: 'agent-a', sessionId: 's-1', account, from: 'logins' })).toBe(false)
    expect(actor.order).toEqual(['wait s-1 1800000'])
    expect(actor.delivered).toEqual([])
  })
})
