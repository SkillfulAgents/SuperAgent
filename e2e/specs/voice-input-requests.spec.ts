import { expect, test } from '@playwright/test'
import { createAgent, createSession, gotoAgentSession, waitForSessionIdle } from '../helpers/agents'
import { installLiveVoiceMocks } from '../helpers/live-voice'
import { SessionPage } from '../pages/session.page'

for (const scenario of [
  { kind: 'question', trigger: 'ask question', details: ['question card', 'Which database should we use?'] },
  { kind: 'secret', trigger: 'ask secret', details: ['secret card', 'OPENAI_API_KEY', 'Needed for API access'] },
  { kind: 'connected account', trigger: 'ask account', details: ['connection card', 'github', 'Need access to your GitHub repositories'] },
  { kind: 'browser input', trigger: 'subagent browser input', details: ['browser', 'Log in to GitHub', 'Complete 2FA if prompted'] },
]) {
  test(`Live announces a ${scenario.kind} request while the voice composer is paused`, async ({ page, request }) => {
    await page.route('**/api/voice/configured', route => route.fulfill({ json: {
      configured: true, supportsTts: true, conversationEngine: 'openai-live',
    } }))
    await page.route('**/api/voice/live/agents/*/session', route => route.fulfill({ status: 201, json: {
      handle: 'test-live-session', transport: { type: 'webrtc', sdp: 'mock-answer' }, expiresAt: Date.now() + 3600000,
    } }))
    await page.route('**/api/voice/live/session/*', route => route.fulfill({ json: { closed: true } }))

    const agent = await createAgent(request, `Voice Input ${scenario.kind} ${Date.now()}`)
    const session = await createSession(request, agent, 'Give me a short greeting')
    await waitForSessionIdle(request, agent, session)
    await gotoAgentSession(page, agent, session)
    const live = await page.evaluateHandle(installLiveVoiceMocks)
    await page.getByTestId('voice-mode-button').click()
    await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
    await expect.poll(() => live.evaluate(state => state.microphoneEnabled())).toBe(true)

    const response = await request.post(`/api/agents/${agent.slug}/sessions/${session.id}/messages`, {
      data: { content: scenario.trigger },
    })
    expect(response.ok()).toBe(true)
    await expect(page.getByTestId('pending-request-slot')).toBeVisible()
    await expect(page.getByTestId('voice-mode-composer')).toBeHidden()
    const commentary = () => live.evaluate(state => state.events
      .filter(event => event.type === 'session.commentary.append')
      .map(event => event.content).join(' '))
    for (const detail of scenario.details) await expect.poll(commentary).toContain(detail)
    await expect.poll(() => live.evaluate(state => state.microphoneEnabled())).toBe(false)

    if (scenario.kind === 'question') {
      await new SessionPage(page).answerQuestion('PostgreSQL')
    } else {
      const stopped = await request.post(`/api/agents/${agent.slug}/sessions/${session.id}/interrupt`, { data: {} })
      expect(stopped.ok()).toBe(true)
    }
    await expect(page.getByTestId('voice-mode-composer')).toBeVisible()
    await expect.poll(() => live.evaluate(state => state.microphoneEnabled())).toBe(true)
    expect((await commentary()).match(/Application input request:/g)).toHaveLength(1)
    await page.getByTestId('voice-mode-exit').click()
  })
}
