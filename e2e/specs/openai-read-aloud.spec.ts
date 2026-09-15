import { test, expect } from '@playwright/test'
import { createAgent, createSession, gotoAgentSession, waitForSessionIdle } from '../helpers/agents'

// Exercise the real HTTP adapter and PCM player; only synthesis is mocked.
test('OpenAI read-aloud plays, pauses, resumes, and stops through the standard controls', async ({ page, request }) => {
  await page.route('**/api/voice/configured', route => route.fulfill({ json: {
    configured: true, supportsTts: true, supportsVoiceAgent: true, conversationEngine: 'openai-live',
    voices: [{ id: 'marin', label: 'Marin', description: 'OpenAI' }], defaultVoice: 'marin',
  } }))
  await page.route('**/api/voice/tts-session', route => route.fulfill({ json: {
    provider: 'openai', connection: { transport: 'http' }, voice: 'marin', speed: 1,
  } }))
  const calls: Array<{ provider: string; text: string; voice: string; speed: number }> = []
  const pcm = Buffer.alloc(24000 * 2 * 10)
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 1000), i * 2)
  await page.route('**/api/voice/tts', route => {
    calls.push(route.request().postDataJSON())
    return route.fulfill({ contentType: 'audio/pcm', body: pcm })
  })
  const agent = await createAgent(request, `OpenAI Reader ${Date.now()}`)
  const session = await createSession(request, agent, 'Give me a short greeting')
  await waitForSessionIdle(request, agent, session)
  await gotoAgentSession(page, agent, session)
  const reply = page.getByTestId('message-assistant').last()
  await reply.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Read aloud' }).click()
  const controls = reply.getByTestId('read-aloud-controls')
  await expect(controls).toHaveAttribute('data-status', 'speaking')
  await expect.poll(() => calls.length).toBeGreaterThan(0)
  expect(calls[0]).toMatchObject({ provider: 'openai', voice: 'marin', speed: 1 })
  expect(calls[0].text).toContain('mock response')
  await reply.getByTestId('read-aloud-pause').click()
  await expect(controls).toHaveAttribute('data-status', 'paused')
  await reply.getByTestId('read-aloud-resume').click()
  await expect(controls).toHaveAttribute('data-status', 'speaking')
  await reply.getByTestId('read-aloud-stop').click()
  await expect(reply.getByTestId('read-aloud-stop')).toHaveCount(0)
  await expect(reply.locator('[data-spoken-word]')).toHaveCount(0)
  await expect(reply.getByTestId('read-aloud-error')).toHaveCount(0)
})
