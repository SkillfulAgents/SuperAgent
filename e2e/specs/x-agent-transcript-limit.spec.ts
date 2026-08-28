import { test, expect, type APIRequestContext } from '@playwright/test'
import { mockRecorder } from '../helpers/mock-recorder'
import {
  createAgent,
  createSession,
  listSessionMessages,
  uniqueName,
  waitForSessionIdle,
  type TestAgent,
  type TestSession,
} from '../helpers/agents'

/**
 * Host route the container tool calls: limit returns the compacted tail.
 */

interface MockRecord {
  type: string
  agentSlug: string
  proxyToken?: string
}

const recorder = mockRecorder<MockRecord>()

async function waitForProxyToken(agentSlug: string, timeoutMs = 12000): Promise<string> {
  const found = await recorder.waitFor(
    (r) => r.type === 'container_start' && r.agentSlug === agentSlug && !!r.proxyToken,
    { timeoutMs, label: `container_start with a proxy token for ${agentSlug}` },
  )
  return found.proxyToken!
}

async function allowRead(
  request: APIRequestContext,
  caller: TestAgent,
  target: TestAgent,
) {
  const response = await request.put(`/api/agents/${caller.slug}/x-agent-policies`, {
    data: { policies: [{ operation: 'read', targetSlug: target.slug, decision: 'allow' }] },
  })
  expect(response.ok()).toBeTruthy()
}

async function sendFollowUp(
  request: APIRequestContext,
  agent: TestAgent,
  session: TestSession,
  content: string,
) {
  const response = await request.post(`/api/agents/${agent.slug}/sessions/${session.id}/messages`, {
    data: { content },
  })
  expect(response.ok()).toBeTruthy()
  await waitForSessionIdle(request, agent, session)
}

test.describe('x-agent get-transcript limit', () => {
  test.describe.configure({ timeout: 60000 })

  test('returns the last N compacted messages and the total', async ({ request }, testInfo) => {
    const caller = await createAgent(request, uniqueName(testInfo, 'Transcript Caller'))
    const target = await createAgent(request, uniqueName(testInfo, 'Transcript Target'))
    await createSession(request, caller, `caller ${uniqueName(testInfo, 'wake')}`)
    const token = await waitForProxyToken(caller.slug)
    const session = await createSession(request, target, 'first turn')
    await waitForSessionIdle(request, target, session)
    await sendFollowUp(request, target, session, 'second turn')
    await sendFollowUp(request, target, session, 'third turn')
    await allowRead(request, caller, target)

    const uiMessages = await listSessionMessages(request, target, session)
    expect(uiMessages.length).toBeGreaterThanOrEqual(4)

    const limited = await request.post('/api/x-agent/get-transcript', {
      headers: { Authorization: `Bearer ${token}` },
      data: { slug: target.slug, sessionId: session.id, limit: 2 },
    })
    expect(limited.status()).toBe(200)
    const limitedBody = await limited.json() as { total: number; messages: Array<{ content: string }> }
    expect(limitedBody.total).toBeGreaterThanOrEqual(4)
    expect(limitedBody.messages).toHaveLength(2)

    const full = await request.post('/api/x-agent/get-transcript', {
      headers: { Authorization: `Bearer ${token}` },
      data: { slug: target.slug, sessionId: session.id },
    })
    const fullBody = await full.json() as { total: number; messages: Array<{ content: string }> }
    expect(fullBody.total).toBe(limitedBody.total)
    expect(fullBody.messages.length).toBe(limitedBody.total)
    expect(limitedBody.messages.map((m) => m.content)).toEqual(
      fullBody.messages.slice(-2).map((m) => m.content),
    )
  })
})
