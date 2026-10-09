import { expect, test, type Page, type APIRequestContext } from '@playwright/test'
import { createAgent, createSession, gotoAgentSession, waitForSessionIdle } from '../helpers/agents'
import { installLiveVoiceMocks } from '../helpers/live-voice'

const completionCue = 'The backend agent has finished this turn.'

async function setup(page: Page, request: APIRequestContext) {
  await page.route('**/api/voice/configured', route => route.fulfill({ json: {
    configured: true, supportsTts: true, conversationEngine: 'openai-live',
  } }))
  await page.route('**/api/voice/live/agents/*/session', route => route.fulfill({ status: 201, json: {
    handle: 'test-live-session', transport: { type: 'webrtc', sdp: 'mock-answer' }, expiresAt: Date.now() + 3600000,
  } }))
  await page.route('**/api/voice/live/session/*', route => route.fulfill({ json: { closed: true } }))
  await page.route('**/api/voice/live/map', route => {
    const input = route.request().postDataJSON() as { kind: string; transcript?: string; text?: string }
    if (input.kind === 'reply') return route.fulfill({ json: { text: input.text } })
    const latest = input.transcript?.split('user:').at(-1) ?? ''
    return route.fulfill({ json: latest.includes('Cancel')
      ? { action: 'cancel', text: '' }
      : { action: 'message', text: latest.includes('background') ? 'run background slowly' : latest.includes('slow') ? 'slow response' : 'Give me a short greeting' } })
  })
  const agent = await createAgent(request, `Live Progress ${Date.now()}`)
  const session = await createSession(request, agent, 'Give me a short greeting')
  await waitForSessionIdle(request, agent, session)
  await gotoAgentSession(page, agent, session)
  const live = await page.evaluateHandle(installLiveVoiceMocks)
  await page.getByTestId('voice-mode-button').click()
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  const ask = async (text: string, id: string) => live.evaluate((state, value) => {
    // Include spoken output so consecutive user turns retain their boundaries.
    state.receive({ type: 'session.output_transcript.delta', delta: 'Ready.' })
    state.receive({ type: 'session.input_transcript.delta', delta: value.text })
    state.receive({ type: 'session.delegation.created', delegation: { target: 'client', id: value.id } })
  }, { text, id })
  const replies = () => live.evaluate(state => state.events.filter(event =>
    event.type === 'session.thinking.append' || event.type === 'session.commentary.append'))
  return { live, ask, replies, agent, session }
}

test('Live streams two consecutive replies as thinking and completes each once', async ({ page, request }) => {
  const { ask, replies } = await setup(page, request)
  expect(await replies()).toEqual([])
  for (const index of [1, 2]) {
    await ask(`Give me greeting number ${index}.`, `greeting-${index}`)
    await expect.poll(async () => (await replies()).filter(event => event.content === completionCue).length).toBe(index)
    await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  }
  const sent = await replies()
  expect(sent.filter(event => event.type === 'session.commentary.append').map(event => event.content)).toEqual([completionCue, completionCue])
  const cueIndices = sent.flatMap((event, index) => event.content === completionCue ? [index] : [])
  for (const [index, end] of cueIndices.entries()) {
    const start = index === 0 ? 0 : cueIndices[index - 1] + 1
    expect(sent.slice(start, end).every(event => event.type === 'session.thinking.append')).toBe(true)
    expect(sent.slice(start, end).map(event => event.content).join('')).toBe('This is a mock response from the E2E test container.')
  }
  await page.getByTestId('voice-mode-exit').click()
})

test('Live cancels a running turn without its completion cue, then completes a replacement', async ({ page, request }) => {
  const { ask, replies } = await setup(page, request)
  await ask('Start a slow response.', 'slow-turn')
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'thinking')
  await ask('Cancel that work.', 'cancel-turn')
  await expect.poll(async () => (await replies()).map(event => event.content).join(' ')).toContain('The running agent turn was stopped.')
  expect((await replies()).filter(event => event.content === completionCue)).toHaveLength(0)
  await ask('Give me a greeting instead.', 'replacement-turn')
  await expect.poll(async () => (await replies()).filter(event => event.content === completionCue)).toHaveLength(1)
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  const sent = await replies()
  expect(sent.filter(event => event.type === 'session.thinking.append').map(event => event.content).join('')).toBe('This is a mock response from the E2E test container.')
  await page.getByTestId('voice-mode-exit').click()
})

test('Live waits through background work and its wakeup before announcing completion', async ({ page, request }) => {
  const { ask, replies } = await setup(page, request)
  await ask('Run the background task.', 'background-turn')
  // The parent turn has ended here, but the real host still owns a live task.
  await expect(page.getByTestId('background-task-row')).toBeVisible()
  await expect.poll(async () => (await replies()).filter(event => event.type === 'session.thinking.append').length).toBeGreaterThan(0)
  expect((await replies()).filter(event => event.content === completionCue)).toHaveLength(0)
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'thinking')
  await expect.poll(async () => (await replies()).filter(event => event.content === completionCue), { timeout: 15_000 }).toHaveLength(1)
  const sent = await replies()
  const context = sent.filter(event => event.type === 'session.thinking.append').map(event => event.content).join('')
  expect(context).toContain('done sleeping')
  expect(sent.at(-1)?.content).toBe(completionCue)
  await expect(page.getByTestId('background-task-row')).not.toBeVisible()
  await page.getByTestId('voice-mode-exit').click()
})

test('Live recovers the final response when a turn finishes while the message stream is disconnected', async ({ page, request }) => {
  await page.addInitScript(() => {
    const NativeEventSource = EventSource
    const streams: EventSource[] = []
    Object.assign(window, { __voiceTestStreams: streams })
    window.EventSource = class extends NativeEventSource {
      constructor(url: string | URL, options?: EventSourceInit) {
        super(url, options)
        if (this.url.includes('/sessions/')) streams.push(this)
      }
    }
  })
  const { ask, replies, agent, session } = await setup(page, request)
  const stream = await page.evaluateHandle(() => (window as unknown as { __voiceTestStreams: EventSource[] }).__voiceTestStreams.at(-1)!)
  await ask('Start a slow response.', 'offline-turn')
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'thinking')
  // Closing the actual socket reliably cuts an already-established SSE body;
  // browser offline emulation can leave that response flowing on localhost.
  await stream.evaluate(source => {
    source.close()
    source.onerror?.(new Event('error'))
  })
  await waitForSessionIdle(request, agent, session)
  expect((await replies()).filter(event => event.content === completionCue)).toHaveLength(0)
  // Reattach the application's existing callbacks to a fresh real SSE request,
  // as EventSource does after a transport failure. The server supplies connected.
  const reconnected = await stream.evaluateHandle(source => {
    const next = new EventSource(source.url, { withCredentials: source.withCredentials })
    next.onmessage = source.onmessage
    next.onerror = source.onerror
    return next
  })
  await expect.poll(async () => (await replies()).filter(event => event.content === completionCue), { timeout: 15_000 }).toHaveLength(1)
  expect((await replies()).filter(event => event.type === 'session.thinking.append').map(event => event.content).join(''))
    .toContain('This is a delayed mock response.')
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  await page.getByTestId('voice-mode-exit').click()
  await reconnected.evaluate(source => source.close())
})

test('Live recovers a lost idle event from the server heartbeat', async ({ page, request }) => {
  test.setTimeout(60_000)
  await page.addInitScript(() => {
    const descriptor = Object.getOwnPropertyDescriptor(EventSource.prototype, 'onmessage')!
    Object.defineProperty(EventSource.prototype, 'onmessage', {
      ...descriptor,
      set(this: EventSource, listener: ((event: MessageEvent) => void) | null) {
        descriptor.set!.call(this, (event: MessageEvent) => {
          try {
            if (this.url.includes('/sessions/') && JSON.parse(event.data).type === 'session_idle') return
          } catch { /* Pass malformed frames through to the application. */ }
          listener?.call(this, event)
        })
      },
    })
  })
  const { ask, replies, agent, session } = await setup(page, request)
  await ask('Give me a greeting.', 'lost-idle')
  await waitForSessionIdle(request, agent, session)
  expect((await replies()).filter(event => event.content === completionCue)).toHaveLength(0)
  await expect.poll(async () => (await replies()).filter(event => event.content === completionCue), { timeout: 35_000 }).toHaveLength(1)
  await expect(page.getByTestId('voice-mode-composer')).toHaveAttribute('data-phase', 'listening')
  await page.getByTestId('voice-mode-exit').click()
})
