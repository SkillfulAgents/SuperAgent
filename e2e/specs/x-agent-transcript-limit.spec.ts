import { test, expect, type APIRequestContext, type TestInfo } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
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

const E2E_DATA_DIR = path.resolve(process.cwd(), process.env.SUPERAGENT_DATA_DIR ?? '.e2e-data')
const RECORDER_FILE = path.join(E2E_DATA_DIR, '.e2e-mock-recorder.jsonl')

interface MockRecord {
  type: string
  agentSlug: string
  proxyToken?: string
}

function readRecords(): MockRecord[] {
  if (!fs.existsSync(RECORDER_FILE)) return []
  return fs
    .readFileSync(RECORDER_FILE, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MockRecord)
}

async function waitForProxyToken(agentSlug: string, timeoutMs = 12000): Promise<string> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readRecords().find((r) => r.type === 'container_start' && r.agentSlug === agentSlug)
    if (found?.proxyToken) return found.proxyToken
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timed out waiting for proxy token for ${agentSlug}`)
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
