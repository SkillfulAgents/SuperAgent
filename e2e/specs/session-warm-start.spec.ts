import { test, expect } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { createAgent, createSession, openAgentSession, uniqueName, waitForSessionIdle } from '../helpers/agents'
import { mockRecorder, type MockRecordBase } from '../helpers/mock-recorder'

interface WarmRecord extends MockRecordBase {
  sessionId?: string
}

test('typing warms the existing session through the API and warms it again after a pause', async ({ page, request }, testInfo) => {
  const agent = await createAgent(request, uniqueName(testInfo, 'Warm Session'))
  const session = await createSession(request, agent, 'A conversation to come back to')
  await waitForSessionIdle(request, agent, session)
  const recorder = mockRecorder<WarmRecord>()
  const warms = () => recorder.read().filter((record) => record.type === 'warmSession' && record.agentSlug === agent.slug)
  const now = Date.now()
  await page.clock.setFixedTime(now)

  const app = new AppPage(page)
  await app.goto()
  await app.waitForAgentsLoaded()
  await openAgentSession(page, agent, session)
  const input = page.getByTestId('message-input')
  const startResponse = page.waitForResponse((response) => response.url().endsWith(`/api/agents/${agent.slug}/start`) && response.request().method() === 'POST')
  await input.fill('A reply after a pause')
  const response = await startResponse
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON()).toEqual({ sessionId: session.id })
  await expect.poll(() => warms().map((record) => record.sessionId)).toEqual([session.id])

  await input.fill('A reply after a pause, still typing')
  await page.clock.setFixedTime(now + 60_001)
  const secondStart = page.waitForResponse((next) => next.url().endsWith(`/api/agents/${agent.slug}/start`) && next.request().method() === 'POST')
  await input.fill('A reply after another pause')
  expect((await secondStart).status()).toBe(200)
  await expect.poll(() => warms().map((record) => record.sessionId)).toEqual([session.id, session.id])

  // Warming leaves the conversation idle; only an actual send starts a turn.
  const sessions = await request.get(`/api/agents/${agent.slug}/sessions`)
  expect(sessions.ok()).toBeTruthy()
  const current = (await sessions.json() as Array<{ id: string; isActive: boolean }>).find((item) => item.id === session.id)
  expect(current?.isActive).toBe(false)
})
