import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAILiveBridge, liveTextChunks } from './openai-live-bridge'

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
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ action: 'message', text: 'Check Thursday.' })
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
