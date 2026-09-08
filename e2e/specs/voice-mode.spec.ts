import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import { AppPage } from '../pages/app.page'
import { AgentPage } from '../pages/agent.page'
import { SessionPage } from '../pages/session.page'

/**
 * Voice mode: talk to the agent, hear its replies.
 *
 * Speech is mocked at the edges the browser talks to. The voice endpoints
 * are answered by page routes; the Deepgram transcription and speech
 * sockets are answered by routeWebSocket mocks that the test drives (feeding
 * transcripts in, recording the text the reader sends out); and the
 * microphone is a silent MediaStream so no real device is asked for. The
 * app in between — the listener, the send-on-silence loop, the streaming
 * reader, the notices and their boundaries — is the real thing against the
 * mock container.
 */

const MOCK_REPLY = 'This is a mock response from the E2E test container.'

interface SpeechMocks {
  /** The open transcription socket, once the page has connected. */
  listen: () => WebSocketRoute | null
  /** Every JSON message the page sent to the speech socket. */
  speakMessages: string[]
  /** Text the reader has asked the synthesizer to say. */
  spokenText: () => string
  /** Feed a transcript result to the page. */
  hear: (transcript: string, options?: { final?: boolean }) => void
  /** The server's silence detection. */
  pause: () => void
}

async function mockSpeech(page: Page, { supportsTts = true } = {}): Promise<SpeechMocks> {
  await page.route('**/api/voice/configured', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        configured: true,
        supportsVoiceAgent: false,
        supportsTts,
        voices: supportsTts ? [{ id: 'aura-2-thalia-en', label: 'Thalia', description: 'Clear, confident, energetic' }] : [],
        defaultVoice: supportsTts ? 'aura-2-thalia-en' : undefined,
      }),
    }),
  )
  await page.route('**/api/voice/token', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ provider: 'deepgram', token: 'listen-token' }) }),
  )
  await page.route('**/api/voice/tts-token', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ provider: 'deepgram', token: 'speak-token', voice: 'aura-2-thalia-en', speed: 1 }),
    }),
  )

  // A silent microphone: real capture wiring, no device prompt.
  await page.addInitScript(() => {
    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices)
    Object.defineProperty(navigator, 'mediaDevices', { value: mediaDevices, configurable: true })
    mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext()
      const destination = ctx.createMediaStreamDestination()
      return destination.stream
    }
  })

  let listen: WebSocketRoute | null = null
  await page.routeWebSocket(/api\.deepgram\.com\/v1\/listen/, (ws) => {
    listen = ws
    ws.onMessage((message) => {
      if (typeof message !== 'string') return // audio
      const data = JSON.parse(message) as { type?: string }
      if (data.type === 'Finalize') {
        ws.send(JSON.stringify({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: '' }] } }))
      }
    })
    ws.onClose(() => {
      if (listen === ws) listen = null
    })
  })

  const speakMessages: string[] = []
  await page.routeWebSocket(/api\.deepgram\.com\/v1\/speak/, (ws) => {
    let sequence = 0
    ws.onMessage((message) => {
      if (typeof message !== 'string') return
      speakMessages.push(message)
      const data = JSON.parse(message) as { type?: string }
      // No audio comes back: the reader finishes as each batch is reported flushed.
      if (data.type === 'Flush') ws.send(JSON.stringify({ type: 'Flushed', sequence_id: sequence++ }))
    })
  })

  const send = (payload: unknown) => {
    if (!listen) throw new Error('The page has not opened the transcription socket')
    listen.send(JSON.stringify(payload))
  }
  return {
    listen: () => listen,
    speakMessages,
    spokenText: () =>
      speakMessages
        .map((m) => JSON.parse(m) as { type?: string; text?: string })
        .filter((m) => m.type === 'Speak')
        .map((m) => m.text)
        .join(' '),
    hear: (transcript, { final = false } = {}) =>
      send({ type: 'Results', is_final: final, speech_final: final, channel: { alternatives: [{ transcript }] } }),
    pause: () => send({ type: 'UtteranceEnd' }),
  }
}

test.describe('voice mode', () => {
  let appPage: AppPage
  let agentPage: AgentPage
  let sessionPage: SessionPage

  test.beforeEach(async ({ page, request }) => {
    appPage = new AppPage(page)
    agentPage = new AgentPage(page)
    sessionPage = new SessionPage(page)
    // The speed and hold-sound settings outlive a test: a run that failed
    // between changing and restoring them must not fail the retry too.
    const reset = await request.put('/api/user-settings', { data: { voice: { ttsSpeed: 1, holdSound: true } } })
    expect(reset.ok()).toBe(true)
  })

  test('is offered only when the provider can both hear and speak', async ({ page }, testInfo) => {
    await mockSpeech(page, { supportsTts: false })
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Voice Gate ${testInfo.workerIndex}-${Date.now()}`)
    await expect(page.getByTestId('voice-input-button')).toBeVisible()
    await expect(page.getByTestId('voice-mode-button')).toHaveCount(0)
  })

  test('talk, hear the reply, and leave: the whole loop from the session composer', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const speech = await mockSpeech(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Voice Loop ${testInfo.workerIndex}-${Date.now()}`)

    // A settled turn first, so the session exists and the stream is connected.
    await sessionPage.sendMessage('hello before voice')
    await sessionPage.waitForAssistantMessageCount(1)

    await page.getByTestId('voice-mode-button').click()
    const composer = page.getByTestId('voice-mode-composer')
    await expect(composer).toBeVisible()
    await expect(composer).toHaveAttribute('data-phase', 'listening')
    await expect(page.getByTestId('message-input')).toHaveCount(0)
    // The agent is told, as a boundary in the transcript.
    const entered = page.getByTestId('voice-mode-boundary').filter({ hasText: 'Entered Voice Mode' })
    await expect(entered).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('The user switched to voice mode')).toHaveCount(0)

    // Reading speed and the hold sound sit under the mic; both are the
    // person's own settings, so they hold across sessions. (Each is put
    // back, since the settings outlive this test.)
    await expect(page.getByTestId('voice-mode-speed')).toHaveText('1×')
    const holdSound = page.getByTestId('voice-mode-hold-sound')
    await expect(holdSound).toHaveAttribute('aria-pressed', 'true')
    const savedSettings = () =>
      page.waitForResponse((response) => response.url().includes('/api/user-settings') && response.request().method() === 'PUT')
    let saved = savedSettings()
    await holdSound.click()
    expect((await saved).status()).toBe(200)
    await expect(holdSound).toHaveAttribute('aria-pressed', 'false')
    saved = savedSettings()
    await holdSound.click()
    expect((await saved).status()).toBe(200)
    await expect(holdSound).toHaveAttribute('aria-pressed', 'true')
    saved = savedSettings()
    await page.getByTestId('voice-mode-speed').click()
    await page.getByRole('option', { name: '1.2×' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByTestId('voice-mode-speed')).toHaveText('1.2×')
    saved = savedSettings()
    await page.getByTestId('voice-mode-speed').click()
    await page.getByRole('option', { name: 'Normal' }).click()
    expect((await saved).status()).toBe(200)
    await expect(page.getByTestId('voice-mode-speed')).toHaveText('1×')

    // The mic is open: what the person says shows above it as it comes in.
    await expect.poll(() => speech.listen() !== null, { timeout: 10_000 }).toBe(true)
    speech.hear('what time is')
    await expect(page.getByTestId('voice-mode-transcript')).toHaveText('what time is')
    speech.hear('what time is it', { final: true })
    await expect(page.getByTestId('voice-mode-transcript')).toHaveText('what time is it')

    // Silence sends it. (The agent's turn is over in well under a second
    // here — the mock answers at once and no audio comes back — so its
    // phases are pinned by the interrupt test, on a slow turn, not here.)
    speech.pause()
    await expect(sessionPage.getUserMessages().filter({ hasText: 'what time is it' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('voice-mode-transcript')).toHaveText('')

    // The reply is read as it streams, and the floor comes back once spoken.
    await expect.poll(() => speech.spokenText(), { timeout: 15_000 }).toContain('mock response')
    await expect(composer).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 })
    expect(speech.spokenText().replace(/\s+/g, ' ')).toBe(MOCK_REPLY)

    // Leaving tells the agent too, and the text box is back.
    await page.getByTestId('voice-mode-exit').click()
    await expect(page.getByTestId('message-input')).toBeVisible()
    await expect(page.getByTestId('voice-mode-composer')).toHaveCount(0)
    await expect(page.getByTestId('voice-mode-boundary').filter({ hasText: 'Exited Voice Mode' })).toBeVisible({ timeout: 10_000 })
    // Neither notice is a message the person sent.
    await expect(sessionPage.getUserMessages()).toHaveCount(2)
  })

  test('talking over the agent interrupts it, and the words are kept', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const speech = await mockSpeech(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Voice Interrupt ${testInfo.workerIndex}-${Date.now()}`)
    await sessionPage.sendMessage('hello before voice')
    await sessionPage.waitForAssistantMessageCount(1)

    await page.getByTestId('voice-mode-button').click()
    const composer = page.getByTestId('voice-mode-composer')
    await expect(composer).toHaveAttribute('data-phase', 'listening')
    await expect.poll(() => speech.listen() !== null, { timeout: 10_000 }).toBe(true)

    // A slow turn (~5s in the mock) to talk over.
    speech.hear('please work slowly', { final: true })
    speech.pause()
    await expect(composer).toHaveAttribute('data-phase', /thinking|speaking/, { timeout: 10_000 })
    await expect(sessionPage.getStopButton().or(page.getByTestId('voice-mode-mic'))).toBeVisible()

    // Three words are not an interruption; four are.
    let interrupts = 0
    page.on('request', (request) => {
      if (request.url().includes('/interrupt') && request.method() === 'POST') interrupts++
    })
    const interrupted = page.waitForRequest((request) => request.url().includes('/interrupt') && request.method() === 'POST')
    speech.hear('stop right there')
    // The three words were heard (an interrupt for them would have gone out
    // in the same breath), and none did.
    await expect(composer).toHaveAttribute('data-utterance', 'stop right there')
    await expect(composer).toHaveAttribute('data-phase', /thinking|speaking/)
    expect(interrupts).toBe(0)
    speech.hear('stop right there please')
    await interrupted
    expect(interrupts).toBe(1)
    await expect(composer).toHaveAttribute('data-phase', 'listening')
    await expect(page.getByTestId('voice-mode-transcript')).toHaveText('stop right there please')
    await expect(sessionPage.getStopButton()).toHaveCount(0, { timeout: 10_000 })
  })

  test('starts from the agent home, and leaving the session ends it', async ({ page }, testInfo) => {
    test.setTimeout(90_000)
    const speech = await mockSpeech(page)
    await appPage.goto()
    await appPage.waitForAgentsLoaded()
    await agentPage.createAgent(`Voice Home ${testInfo.workerIndex}-${Date.now()}`)

    await page.getByTestId('voice-mode-button').click()
    await expect(page).toHaveURL(/\/sessions\//, { timeout: 15_000 })
    const composer = page.getByTestId('voice-mode-composer')
    await expect(composer).toBeVisible()
    await expect(page.getByTestId('voice-mode-boundary').filter({ hasText: 'Entered Voice Mode' })).toBeVisible({ timeout: 10_000 })
    // The notice named nothing: the session is still untitled by it.
    await expect(page.getByText('[SYSTEM]')).toHaveCount(0)

    // The agent's reply to the notice is read out, then the floor is the person's.
    await expect.poll(() => speech.spokenText(), { timeout: 15_000 }).toContain("I'm listening")
    await expect(composer).toHaveAttribute('data-phase', 'listening', { timeout: 15_000 })
    await expect.poll(() => speech.listen() !== null).toBe(true)

    // Navigating away ends voice mode and tells the agent.
    const sessionUrl = page.url()
    const exitNotice = page.waitForResponse(
      (response) => response.url().includes('/messages') && response.request().method() === 'POST',
      { timeout: 10_000 },
    )
    await page.goBack()
    await expect(page).not.toHaveURL(sessionUrl)
    await expect.poll(() => speech.listen(), { timeout: 10_000 }).toBeNull()
    // The notice is sent as the session view unmounts; a reload before it
    // lands would cut it off.
    expect((await exitNotice).status()).toBe(201)
    await page.goto(sessionUrl)
    await expect(page.getByTestId('message-input')).toBeVisible()
    await expect(page.getByTestId('voice-mode-boundary').filter({ hasText: 'Exited Voice Mode' })).toBeVisible({ timeout: 10_000 })
  })
})
