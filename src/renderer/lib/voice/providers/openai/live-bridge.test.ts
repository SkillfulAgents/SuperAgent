import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAILiveBridge, liveTextChunks } from './live-bridge'
import { LIVE_TURN_COMPLETE_CUE } from '@shared/lib/voice/live-types'

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

  it('orders thinking and the completion cue behind a delayed summary with the same delegation', async () => {
    const { bridge, events, user, delegate } = setup()
    user('Check Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    bridge.reply('Detailed findings. '.repeat(100))
    bridge.reply('Nothing has been sent.')
    bridge.completeReply()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).not.toHaveBeenCalled()
    const summary = 'Friday works. 世界 🌍 '.repeat(30)
    resolve({ text: summary })
    await vi.advanceTimersByTimeAsync(0)
    const sent = events.send.mock.calls.map(([event]) => event)
    expect(sent.slice(0, -1).every(event => event.type === 'session.thinking.append')).toBe(true)
    expect(sent.slice(0, -1).map(event => event.content).join('')).toBe(summary + 'Nothing has been sent.')
    expect(sent.at(-1)).toMatchObject({ type: 'session.commentary.append', content: LIVE_TURN_COMPLETE_CUE })
    expect(sent.every(event => event.delegation_id === 'item_1')).toBe(true)
    expect(sent.every(event => new TextEncoder().encode(event.content).length <= 400)).toBe(true)
    bridge.close()
  })

  it('does not leak delayed replies or completion cues across a new request or a closed session', async () => {
    const { bridge, events } = setup()
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    bridge.reply('old response '.repeat(100))
    bridge.completeReply()
    await Promise.resolve()
    bridge.invalidateReplies()
    resolve({ text: 'Outdated answer.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).not.toHaveBeenCalled()
    bridge.reply('Never spoken.')
    bridge.completeReply()
    bridge.close()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'empty'])('preserves the result before completion if the reply summarizer is %s', async (failure) => {
    const { bridge, events } = setup()
    if (failure === 'unavailable') events.map.mockRejectedValueOnce(new Error('Summarizer unavailable.'))
    else events.map.mockResolvedValueOnce({ text: ' ' })
    const result = 'The PDF is ready; the signing service rejected the login. Nothing was sent or charged. '.repeat(10)
    bridge.reply(result)
    bridge.completeReply()
    await vi.advanceTimersByTimeAsync(0)
    const sent = events.send.mock.calls.map(([event]) => event)
    expect(sent.filter(event => event.type === 'session.thinking.append').map(event => event.content).join('')).toBe(result)
    expect(sent.at(-1)).toMatchObject({ type: 'session.commentary.append', content: LIVE_TURN_COMPLETE_CUE })
    expect(events.onError).toHaveBeenCalledOnce()
    bridge.close()
  })

  it('does not fall back to an old result if its summarizer fails after cancellation', async () => {
    const { bridge, events } = setup()
    let reject!: (error: Error) => void
    events.map.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    bridge.reply('Obsolete result. '.repeat(100))
    bridge.completeReply()
    await vi.advanceTimersByTimeAsync(0)
    bridge.invalidateReplies()
    reject(new Error('Cancelled summarizer.'))
    bridge.reply('The replacement result.')
    bridge.completeReply()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send.mock.calls.map(([event]) => event.content)).toEqual(['The replacement result.', LIVE_TURN_COMPLETE_CUE])
    expect(events.onError).not.toHaveBeenCalled()
    bridge.close()
  })

  it('does not announce completion while paused for user input', async () => {
    const { bridge, events } = setup()
    bridge.reply('The draft needs approval.')
    bridge.completeReply()
    bridge.setPaused(true)
    bridge.commentary('Application input request: Approve the $12 cost in the app.')
    await vi.advanceTimersByTimeAsync(0)
    const sent = events.send.mock.calls.map(([event]) => event)
    expect(sent.filter(event => event.type === 'session.commentary.append').map(event => event.content)).toEqual([
      'Application input request: Approve the $12 cost in the app.',
    ])
    expect(sent).toContainEqual(expect.objectContaining({ type: 'session.thinking.append', content: 'The draft needs approval.' }))
    bridge.close()
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
