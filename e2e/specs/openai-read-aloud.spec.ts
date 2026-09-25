import { test, expect, type Page } from '@playwright/test'
import { createAgent, createSession, gotoAgentSession, waitForSessionIdle } from '../helpers/agents'

// Exercise the real HTTP adapter and PCM player; only synthesis is mocked.
async function mockReadAloud(page: Page) {
  await page.route('**/api/voice/configured', route => route.fulfill({ json: {
    configured: true, supportsTts: true, conversationEngine: 'openai-live',
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
  return calls
}

test('OpenAI read-aloud plays, pauses, resumes, and stops through the standard controls', async ({ page, request }) => {
  const calls = await mockReadAloud(page)
  const agent = await createAgent(request, `OpenAI Reader ${Date.now()}`)
  const session = await createSession(request, agent, 'Give me a short greeting')
  await waitForSessionIdle(request, agent, session)
  await gotoAgentSession(page, agent, session)
  const reply = page.getByTestId('message-assistant').last()
  await reply.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Read aloud' }).click()
  const controls = reply.getByTestId('read-aloud-controls')
  await expect(controls).toHaveAttribute('data-status', 'speaking')
  if (test.info().project.name === 'web-webkit') {
    // Assert that the Safari media sink itself is playing, not just the word cursor.
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(audio =>
      audio.srcObject instanceof MediaStream && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0,
    ))).toBe(true)
  }
  await expect.poll(() => calls.length).toBeGreaterThan(0)
  expect(calls[0]).toMatchObject({ provider: 'openai', voice: 'marin', speed: 1 })
  expect(calls[0].text).toContain('mock response')
  await reply.getByTestId('read-aloud-pause').click()
  await expect(controls).toHaveAttribute('data-status', 'paused')
  if (test.info().project.name === 'web-webkit') {
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(audio =>
      audio.srcObject instanceof MediaStream && audio.paused && audio.muted,
    ))).toBe(true)
  }
  await reply.getByTestId('read-aloud-resume').click()
  await expect(controls).toHaveAttribute('data-status', 'speaking')
  if (test.info().project.name === 'web-webkit') {
    await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].some(audio =>
      audio.srcObject instanceof MediaStream && !audio.paused && !audio.muted,
    ))).toBe(true)
  }
  await reply.getByTestId('read-aloud-stop').click()
  await expect(reply.getByTestId('read-aloud-stop')).toHaveCount(0)
  await expect(reply.locator('[data-spoken-word]')).toHaveCount(0)
  await expect(reply.getByTestId('read-aloud-error')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => [...document.querySelectorAll('audio')].filter(audio => audio.srcObject instanceof MediaStream).length)).toBe(0)
})

test('Live stops read-aloud and reserves audio until the call exits', async ({ page, request }) => {
  const calls = await mockReadAloud(page)
  await page.route('**/api/voice/live/agents/*/session', route => route.fulfill({ status: 201, json: {
    handle: 'test-live-session', transport: { type: 'webrtc', sdp: 'mock-answer' }, expiresAt: Date.now() + 3600000,
  } }))
  await page.route('**/api/voice/live/session/*', route => route.fulfill({ json: { closed: true } }))
  const installLiveMocks = () => {
    // WebKit can lose an instance override before Live acquires the microphone.
    // Patch the prototype so startup always uses the fake stream.
    MediaDevices.prototype.getUserMedia = async () => new AudioContext().createMediaStreamDestination().stream
    class Channel {
      readyState = 'open'
      onmessage?: (event: { data: string }) => void
      send() {}
      close() {}
    }
    window.RTCPeerConnection = class {
      channel = new Channel()
      connectionState = 'connected'
      iceGatheringState = 'complete'
      localDescription = { type: 'offer', sdp: 'mock-offer' }
      createDataChannel() { return this.channel }
      async createOffer() { return this.localDescription }
      async setLocalDescription() {}
      async setRemoteDescription() {
        setTimeout(() => this.channel.onmessage?.({ data: JSON.stringify({ type: 'session.started' }) }), 10)
      }
      addTrack() {}
      close() {}
    } as unknown as typeof RTCPeerConnection
  }
  if (process.env.VOICE_REVIEW_SCREENSHOTS) {
    const configured = await request.put('/api/settings', { data: { apiKeys: { anthropicApiKey: 'sk-ant-e2e-mock-key' } } })
    expect(configured.ok()).toBe(true)
  }
  const agent = await createAgent(request, process.env.VOICE_REVIEW_SCREENSHOTS ? 'Voice Assistant' : `Live Audio Owner ${Date.now()}`)
  const session = await createSession(request, agent, 'Give me a short greeting')
  await waitForSessionIdle(request, agent, session)
  await gotoAgentSession(page, agent, session)
  const reply = page.getByTestId('message-assistant').first()
  await reply.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Read aloud' }).click()
  await expect(reply.getByTestId('read-aloud-controls')).toHaveAttribute('data-status', 'speaking')
  await page.evaluate(installLiveMocks)
  expect(await page.evaluate(() => navigator.mediaDevices.getUserMedia.toString())).toContain('createMediaStreamDestination')
  expect(await page.evaluate(() => RTCPeerConnection.toString())).toContain('mock-offer')
  const liveStartup = page.waitForResponse(response =>
    /\/api\/voice\/live\/agents\/[^/]+\/session$/.test(response.url()) && response.request().method() === 'POST',
  )
  await page.getByTestId('voice-mode-button').click()
  expect((await liveStartup).status()).toBe(201)
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  await expect(reply.getByTestId('read-aloud-controls')).toHaveCount(0)
  const requestsBefore = calls.length
  await reply.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy', exact: true })).toBeVisible()
  await expect(page.getByTestId('context-read-aloud')).toHaveCount(0)
  if (process.env.VOICE_REVIEW_SCREENSHOTS) {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('html').evaluate(node => node.classList.contains('dark'))).toBe(colorScheme === 'dark')
      await page.screenshot({ path: `${process.env.VOICE_REVIEW_SCREENSHOTS}/live-audio-owner-${colorScheme}.png`, animations: 'disabled' })
    }
  }
  await page.keyboard.press('Escape')
  await page.getByTestId('voice-mode-exit').click()
  await expect(page.getByTestId('voice-mode-composer')).toHaveCount(0)
  expect(calls.length).toBe(requestsBefore)
  await reply.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Read aloud' }).click()
  await expect(reply.getByTestId('read-aloud-controls')).toHaveAttribute('data-status', 'speaking')
  await expect.poll(() => calls.length).toBeGreaterThan(requestsBefore)
  await reply.getByTestId('read-aloud-stop').click()
})
