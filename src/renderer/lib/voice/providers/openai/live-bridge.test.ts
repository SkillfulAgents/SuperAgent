import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CONSECUTIVE_CLARIFY, OpenAILiveBridge, liveTextChunks } from './live-bridge'

function setup() {
  const events = {
    send: vi.fn(), map: vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<unknown> => ({ action: 'message', text: 'Check Friday.' })),
    onRequest: vi.fn(async () => true), onUtterance: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(),
  }
  const bridge = new OpenAILiveBridge(events)
  const user = (delta: string) => bridge.receive({ type: 'session.input_transcript.delta', delta })
  const delegate = (id = 'item_1') => bridge.receive({ type: 'session.delegation.created', delegation: { target: 'client', id } })
  return { bridge, events, user, delegate }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

 describe('OpenAI voice mapping bridge', () => {
  it('waits for transcripts arriving after delegation and preserves fragment whitespace', async () => {
    const { bridge, events, user, delegate } = setup()
    delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.map).not.toHaveBeenCalled()
    user('Check '); user('Friday.')
    await vi.advanceTimersByTimeAsync(700)
    expect(events.map.mock.calls[0][0]).toMatchObject({ transcript: 'user: Check Friday.' })
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'Check Friday.' })
    delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.onRequest).toHaveBeenCalledTimes(1)
    bridge.close()
  })

  it('publishes interlaced spoken subtitles that survive an agent handoff', async () => {
    const { bridge, events, user, delegate } = setup()
    user('Check ')
    const first = events.onTranscript.mock.calls.at(-1)![0]
    user('Friday.')
    bridge.receive({ type: 'session.output_transcript.delta', delta: "I'll check." })
    user(' And Thursday.')
    expect(first).toEqual([{ role: 'user', text: 'Check ' }])
    expect(events.onTranscript).toHaveBeenLastCalledWith([
      { role: 'user', text: 'Check Friday.' },
      { role: 'assistant', text: "I'll check." },
      { role: 'user', text: ' And Thursday.' },
    ])
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onUtterance).toHaveBeenLastCalledWith('')
    expect(events.onTranscript.mock.calls.at(-1)![0]).toHaveLength(3)
    const count = events.onTranscript.mock.calls.length
    bridge.reply('The backend text is separate from the spoken reply.')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onTranscript).toHaveBeenCalledTimes(count)
    bridge.close()
  })

  it('keeps assistant subtitles flowing while paused for a request card, dropping input and delegations', async () => {
    const { bridge, events, user, delegate } = setup()
    bridge.setPaused(true)
    bridge.receive({ type: 'session.output_transcript.delta', delta: 'Please connect ' })
    bridge.receive({ type: 'session.output_transcript.delta', delta: 'your account.' })
    expect(events.onTranscript).toHaveBeenLastCalledWith([{ role: 'assistant', text: 'Please connect your account.' }])
    user('Ignored while paused'); delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.onUtterance).not.toHaveBeenCalled()
    expect(events.map).not.toHaveBeenCalled()
    bridge.close()
  })

  it('discards an in-flight mapping if the user adds a correction', async () => {
    const { bridge, events, user, delegate } = setup()
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    user('Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    const firstSignal = events.map.mock.calls[0][1]
    user(' Actually Thursday.')
    expect(firstSignal.aborted).toBe(true)
    resolve({ action: 'message', text: 'Check Friday.' })
    await Promise.resolve()
    expect(events.onRequest).not.toHaveBeenCalled()
    events.map.mockResolvedValue({ action: 'message', text: 'Check Thursday.' })
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'Friday. Actually Thursday.' })
    bridge.close()
  })

  it('does not execute a clarification or a stop-speaking request', async () => {
    const { bridge, events, user, delegate } = setup()
    events.map.mockResolvedValueOnce({ action: 'clarify', text: 'Which day?' })
    user('Check...'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.commentary.append', delegation_id: 'item_1', content: 'Clarification needed: Which day?' }))
    events.map.mockResolvedValueOnce({ action: 'none', text: '' })
    user('Stop talking.'); delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).not.toHaveBeenCalled()
    bridge.close()
  })

  it('passes the user\'s own words and the mapper\'s last clarification, accumulating across clarifications', async () => {
    const { bridge, events, user, delegate } = setup()
    bridge.receive({ type: 'session.output_transcript.delta', delta: 'There is no Casual Greeting Agent here. Want me to create one?' })
    user('You are the new casual greeting agent')
    events.map.mockResolvedValueOnce({ action: 'clarify', text: 'Are you asking me to save your Supabase API key and ask for the project URL?' })
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.map.mock.calls[0][0]).toMatchObject({ utterance: 'You are the new casual greeting agent', lastClarify: null })
    expect(events.onUtterance).toHaveBeenLastCalledWith('')
    bridge.receive({ type: 'session.output_transcript.delta', delta: 'Are you asking me to save your Supabase API key and ask for the project URL?' })
    user(' Yes')
    events.map.mockResolvedValueOnce({ action: 'message', text: 'You are the new Casual Greeting Agent, go ahead.' })
    delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(events.map.mock.calls[1][0]).toMatchObject({
      utterance: 'You are the new casual greeting agent Yes',
      lastClarify: 'Are you asking me to save your Supabase API key and ask for the project URL?',
    })
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'You are the new casual greeting agent Yes' })
    user(' Thanks')
    events.map.mockResolvedValueOnce({ action: 'none', text: '' })
    delegate('item_3')
    await vi.advanceTimersByTimeAsync(700)
    expect(events.map.mock.calls[2][0]).toMatchObject({ utterance: 'Thanks', lastClarify: null })
    bridge.close()
  })

  it.each([
    'Store the Supabase credential, then request the endpoint address.',
    'Save the credentials and ask for the project address.',
  ])('ignores message rewrites from a remote mapper: %s', async (text) => {
    const { bridge, events, user, delegate } = setup()
    user('Do we have Supabase access set up on this agent?')
    events.map.mockResolvedValueOnce({ action: 'message', text })
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'Do we have Supabase access set up on this agent?' })
    bridge.close()
  })

  it('keeps the original user request after it leaves the spoken transcript window', async () => {
    const { bridge, events, user, delegate } = setup()
    const original = 'Do we have Supabase access set up on this agent?'
    user(original)
    events.map.mockResolvedValueOnce({ action: 'clarify', text: 'Do you mean an existing credential?' })
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    for (let i = 0; i < 13; i++) {
      bridge.receive({ type: 'session.output_transcript.delta', delta: 'Want to connect Supabase?' })
      user(' Just check.')
    }
    const utterance = original + ' Just check.'.repeat(13)
    events.map.mockResolvedValueOnce({ action: 'message', text: utterance })
    delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(events.map.mock.calls[1][0]).toMatchObject({ utterance, transcript: expect.not.stringContaining(original) })
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: utterance })
    bridge.close()
  })

  it('stops a clarification loop after the bounded run and sends the user\'s words', async () => {
    const { bridge, events, user, delegate } = setup()
    events.map.mockResolvedValue({ action: 'clarify', text: 'Which agent should I send it to?' })
    user('Just go')
    delegate('item_1')
    for (let i = 0; i < MAX_CONSECUTIVE_CLARIFY; i++) {
      await vi.advanceTimersByTimeAsync(700)
      user(' just do it')
      delegate(`item_${i + 2}`)
    }
    expect(events.onRequest).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'Just go just do it just do it' })
    expect(events.send.mock.calls.filter(([e]) => String((e as { content?: string }).content).startsWith('Clarification needed'))).toHaveLength(MAX_CONSECUTIVE_CLARIFY)
    bridge.close()
  })

  it('keeps a request that quotes the assistant in the user\'s own words', async () => {
    const { bridge, events, user, delegate } = setup()
    bridge.receive({ type: 'session.output_transcript.delta', delta: 'AWS staging read-only is the biggest gap.' })
    user('You said AWS staging read-only is the biggest gap, so request that one.')
    events.map.mockResolvedValueOnce({ action: 'message', text: 'Request AWS staging read-only access, since that is the biggest gap.' })
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'You said AWS staging read-only is the biggest gap, so request that one.' })
    bridge.close()
  })

  it('does not leak delayed replies across a new request or a closed session', async () => {
    const { bridge, events } = setup()
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    bridge.reply('old response '.repeat(100))
    await Promise.resolve()
    bridge.invalidateReplies()
    resolve({ text: 'Outdated answer.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).not.toHaveBeenCalled()
    bridge.close()
    bridge.reply('Never spoken.')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).not.toHaveBeenCalled()
  })

  it('keeps failed mapping available for explicit retry and stops on close', async () => {
    const { bridge, events, user, delegate } = setup()
    events.map.mockRejectedValueOnce(new Error('Unavailable'))
    user('Check Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onError).toHaveBeenCalledWith('Unavailable')
    bridge.requestNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onRequest).toHaveBeenCalledTimes(1)
    user('And Thursday.'); delegate('item_2'); bridge.close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.onRequest).toHaveBeenCalledTimes(1)
  })

  it('bounds append size without losing Unicode or splitting surrogate pairs', () => {
    const text = 'Hello 世界 🌍 '.repeat(100)
    const chunks = liveTextChunks(text)
    expect(chunks.join('')).toBe(text)
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 400)).toBe(true)
  })
  it('does not arm a future delegation when the mic is pressed without unhandled words', async () => {
    const { bridge, events, user, delegate } = setup()
    bridge.requestNow()
    user('Thanks')
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.map).not.toHaveBeenCalled()
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    const count = events.map.mock.calls.length
    bridge.requestNow()
    user('Another casual utterance')
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.map).toHaveBeenCalledTimes(count)
    bridge.close()
  })

})
