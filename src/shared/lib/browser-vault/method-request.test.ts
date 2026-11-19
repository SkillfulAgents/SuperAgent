import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseSignInMethodRequestMessage } from '@shared/lib/utils/sign-in-method-request'

const actor = vi.hoisted(() => ({
  order: [] as string[],
  delivered: [] as Array<Record<string, unknown>>,
  /** Whether a delivery joins a running turn. */
  queued: true,
  idle: 'idle' as 'idle' | 'timeout',
}))

vi.mock('@shared/lib/agent-actor', () => ({
  agentRegistry: {
    get: () => ({
      sessions: {
        waitForIdle: async (sessionId: string) => {
          actor.order.push(`wait ${sessionId}`)
          return actor.idle
        },
      },
      messages: {
        deliver: async (request: Record<string, unknown>) => {
          actor.order.push(`deliver ${String(request.sessionId)}`)
          actor.delivered.push(request)
          return { status: 'sent', queued: actor.queued }
        },
      },
    }),
  },
}))
vi.mock('@shared/lib/auth/mode', () => ({ isAuthMode: () => false }))
vi.mock('@shared/lib/db', () => ({ db: {} }))
const vault = vi.hoisted(() => ({ first: true, open: true, askedIn: undefined as string | undefined }))
vi.mock('./vault-service', () => ({
  markSignInMethodAsked: async () => {
    actor.order.push('mark')
    const first = vault.first
    vault.first = false
    return first
  },
  // The account as the turn ends: its request still open, or answered.
  getAccount: async (id: string) => ({ id, site: 'github.com', origin: 'https://github.com', username: 'octocat', ownerId: null, signInMethods: vault.open ? { requested: { at: 1, from: 'card', askedIn: vault.askedIn } } : {} }),
}))

const { askForSignInMethod, requestedOnCard } = await import('./method-request')
const { backgroundSettled } = await import('@shared/lib/background')

const account = { id: 'acc-1', site: 'github.com', origin: 'https://github.com', username: 'octocat', ownerId: null }
const ask = () => askForSignInMethod({ agentSlug: 'agent-a', sessionId: 's-1', account, from: 'card' })

describe('askForSignInMethod', () => {
  beforeEach(() => {
    actor.order = []
    actor.delivered = []
    actor.queued = true
    actor.idle = 'idle'
    vault.first = true
    vault.open = false
    vault.askedIn = undefined
  })

  it('queues the user\'s request into the session at once, once per session', async () => {
    expect(await ask()).toBe(true)
    await backgroundSettled()
    expect(actor.order).toEqual(['mark', 'deliver s-1', 'wait s-1'])
    const [message] = actor.delivered
    // Queued like a message the user sends mid-turn: never cancelling the sign-in card it waits behind.
    expect(message).toMatchObject({ sessionId: 's-1', options: { shouldQuery: true }, promote: true, coalesce: true, echo: { content: message.content } })
    expect(message).not.toHaveProperty('cancelAwaiting')
    expect(message.content).toMatch(/^From the sign-in form: once you are signed in, also add an authenticator app to my account octocat on github\.com/)
    expect(parseSignInMethodRequestMessage(String(message.content))).toEqual({ username: 'octocat', site: 'github.com', from: 'card' })
    // Answered in that turn: nothing more.
    expect(actor.delivered).toHaveLength(1)

    expect(await ask()).toBe(false)
    expect(actor.delivered).toHaveLength(1)
  })

  it('asks again, as a turn of its own, when the turn it joined ends with the request still open', async () => {
    vault.open = true
    await ask()
    await backgroundSettled()
    expect(actor.order).toEqual(['mark', 'deliver s-1', 'wait s-1', 'deliver s-1'])
    expect(parseSignInMethodRequestMessage(String(actor.delivered[1].content))).toEqual({ username: 'octocat', site: 'github.com', from: 'card', again: true })
  })

  it('asks no more after a delivery that was a turn of its own, or a turn that outlasts the wait', async () => {
    vault.open = true
    actor.queued = false
    await ask()
    await backgroundSettled()
    expect(actor.order).toEqual(['mark', 'deliver s-1'])

    vault.first = true
    actor.order = []
    actor.queued = true
    actor.idle = 'timeout'
    await ask()
    await backgroundSettled()
    expect(actor.order).toEqual(['mark', 'deliver s-1', 'wait s-1'])
  })

  it('on a ticked card, leaves the ask to the card\'s answer, or else to the turn\'s end', async () => {
    vault.open = true
    actor.queued = false
    await requestedOnCard({ agentSlug: 'agent-a', sessionId: 's-1', account })
    await backgroundSettled()
    // The card was answered with no sign-in step: asked once the turn ended.
    expect(actor.order).toEqual(['wait s-1', 'mark', 'deliver s-1'])

    // Asked already, with the step that answered the card: nothing more.
    actor.order = []
    actor.delivered = []
    vault.askedIn = 's-1'
    await requestedOnCard({ agentSlug: 'agent-a', sessionId: 's-1', account })
    await backgroundSettled()
    expect(actor.order).toEqual(['wait s-1'])
    expect(actor.delivered).toEqual([])
  })
})
