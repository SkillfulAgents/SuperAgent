import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Runs the real attribution chain, the real fetch interceptor and the real SDK;
// only storage (token, agent owner, authAccount rows) is stubbed.
const ORG_TOKEN = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
  JSON.stringify({ orgId: 'org_test' }),
).toString('base64url')}.sig`

const mockGetAgentOwnerUserId = vi.fn((_slug: string): string | null => null)
const platformAccountByUser: Record<string, string> = {
  user_creator: 'sub_creator',
  user_owner: 'sub_owner',
}

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => ORG_TOKEN,
  getStoredPlatformMemberId: () => null,
  getPlatformAuthStatus: () => ({ connected: true, orgId: 'org_test' }),
}))
vi.mock('@shared/lib/services/agent-owner', () => ({
  getAgentOwnerUserId: (slug: string) => mockGetAgentOwnerUserId(slug),
}))
vi.mock('@shared/lib/db', () => {
  let condition = ''
  const chainable = {
    select: () => chainable,
    from: () => chainable,
    where: (cond: string) => {
      condition = cond
      return chainable
    },
    orderBy: () => chainable,
    limit: () => chainable,
    all: () => {
      const userId = /account\.user_id=(\S+)/.exec(condition)?.[1] ?? ''
      const accountId = platformAccountByUser[userId]
      return accountId ? [{ accountId }] : []
    },
  }
  return { db: chainable }
})
vi.mock('@shared/lib/db/schema', () => ({
  authAccount: {
    userId: 'account.user_id',
    providerId: 'account.provider_id',
    accountId: 'account.account_id',
    updatedAt: 'account.updated_at',
  },
}))
vi.mock('drizzle-orm', () => ({
  eq: (a: string, b: string) => `${a}=${b}`,
  and: (...args: string[]) => args.join(' AND '),
  desc: (col: string) => `DESC(${col})`,
}))
vi.mock('@shared/lib/error-reporting', () => ({ captureMessage: vi.fn() }))
vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => 'https://proxy.example',
  getPlatformBaseUrl: () => 'https://platform.example.com',
}))
vi.mock('../config/settings', () => ({ getSettings: () => ({}) }))

import { runWithOptionalUser } from '@shared/lib/platform-attribution/request-context'
import {
  installPlatformFetchInterceptor,
  _uninstallPlatformFetchInterceptorForTest,
} from '@shared/lib/platform-attribution/install-fetch-interceptor'
import { PlatformLlmProvider } from './platform-provider'

const provider = new PlatformLlmProvider()
const sentRequests: Array<{ url: string; headers: Headers }> = []
const originalFetch = globalThis.fetch

function fakeMessage(): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

async function sendOnce(agent: { id: string; name?: string }): Promise<{ url: string; headers: Headers }> {
  const client = provider.createClient(agent)
  await client.messages.create({ model: 'test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] })
  expect(sentRequests).toHaveLength(1)
  return sentRequests[0]
}

beforeAll(() => {
  // The SDK binds globalThis.fetch at client construction, so the capture and
  // the interceptor must both be in place before any createClient().
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    sentRequests.push({ url, headers: new Headers(init?.headers) })
    return fakeMessage()
  }) as typeof fetch
  installPlatformFetchInterceptor()
})

afterAll(() => {
  _uninstallPlatformFetchInterceptorForTest()
  globalThis.fetch = originalFetch
})

beforeEach(() => {
  mockGetAgentOwnerUserId.mockReset().mockReturnValue('user_owner')
})

afterEach(() => {
  sentRequests.length = 0
})

describe('host-direct request attribution (creator vs owner)', () => {
  it('attributes Authorization to the session creator while agent headers name the agent', async () => {
    const sent = await runWithOptionalUser('user_creator', () => sendOnce({ id: 'agent_a', name: 'Agent A' }))

    expect(sent.url).toBe('https://proxy.example/v1/messages')
    expect(sent.headers.get('authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_creator`)
    expect(sent.headers.get('x-superagent-agent-id')).toBe('agent_a')
    expect(sent.headers.get('x-superagent-agent-name')).toBe('Agent%20A')
    expect(mockGetAgentOwnerUserId).not.toHaveBeenCalled()
  })

  it('falls back to the agent owner when no session creator scope is active', async () => {
    const sent = await sendOnce({ id: 'agent_a', name: 'Agent A' })

    expect(sent.headers.get('authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_owner`)
    expect(sent.headers.get('x-superagent-agent-id')).toBe('agent_a')
    expect(mockGetAgentOwnerUserId).toHaveBeenCalledWith('agent_a')
  })

  it('falls back to the agent owner when the creator has no platform account', async () => {
    const sent = await runWithOptionalUser('user_without_account', () => sendOnce({ id: 'agent_a' }))

    expect(sent.headers.get('authorization')).toBe(`Bearer ${ORG_TOKEN}::sub_owner`)
  })

  it('sends the bare org token when neither creator nor owner resolves a member', async () => {
    mockGetAgentOwnerUserId.mockReturnValue(null)
    const sent = await sendOnce({ id: 'agent_a' })

    expect(sent.headers.get('authorization')).toBe(`Bearer ${ORG_TOKEN}`)
  })
})
