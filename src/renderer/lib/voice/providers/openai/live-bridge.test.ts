import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAILiveBridge, leaksAssistantSpeech, liveTextChunks } from './live-bridge'

function setup() {
  const events = {
    send: vi.fn(), map: vi.fn(async (_input: unknown, _signal: AbortSignal): Promise<unknown> => ({ text: 'Check Friday.', mode: 'interrupt' })),
    onRequest: vi.fn(async () => true), onUtterance: vi.fn(), onTranscript: vi.fn(), onError: vi.fn(),
  }
  const bridge = new OpenAILiveBridge(events)
  const user = (delta: string) => bridge.receive({ type: 'session.input_transcript.delta', delta })
  const assistant = (delta: string) => bridge.receive({ type: 'session.output_transcript.delta', delta })
  const delegate = (id = 'item_1') => bridge.receive({ type: 'session.delegation.created', delegation: { target: 'client', id } })
  const mapped = (index: number) => events.map.mock.calls[index][0] as Record<string, unknown>
  return { bridge, events, user, assistant, delegate, mapped }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('OpenAI voice mapping bridge', () => {
  it('waits for transcripts arriving after delegation and preserves fragment whitespace', async () => {
    const { bridge, events, user, delegate, mapped } = setup()
    delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.map).not.toHaveBeenCalled()
    user('Check '); user('Friday.')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(0)).toMatchObject({ transcript: 'user: Check Friday.', userWords: 'Check Friday.', previousRequest: '', agentBusy: false })
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ text: 'Check Friday.', mode: 'interrupt' })
    delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.onRequest).toHaveBeenCalledTimes(1)
    bridge.close()
  })

  it('sends only the words the agent has not accepted yet, across the voice assistant\'s turns', async () => {
    const { bridge, events, user, assistant, delegate, mapped } = setup()
    user('Send the Q3 report to Dana.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    assistant('Which Dana do you mean?')
    user(' Dana Smith.')
    events.map.mockResolvedValueOnce({ text: 'Dana Smith.', mode: 'interrupt' })
    delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(1)).toMatchObject({
      transcript: 'user: Send the Q3 report to Dana.\nvoice_assistant: Which Dana do you mean?\nuser:  Dana Smith.',
      userWords: 'Dana Smith.', previousRequest: 'Check Friday.',
    })
    expect(events.onRequest).toHaveBeenLastCalledWith({ text: 'Dana Smith.', mode: 'interrupt' })
    bridge.close()
  })

  it('keeps the words of a rejected dispatch and sends them again with what the user adds', async () => {
    const { bridge, events, user, delegate, mapped } = setup()
    events.onRequest.mockResolvedValueOnce(false)
    user('Check Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onError).toHaveBeenCalledWith('The agent could not accept the voice request. Please try again.')
    user(' Try again.'); delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(1)).toMatchObject({ userWords: 'Check Friday. Try again.', previousRequest: '' })
    expect(events.onRequest).toHaveBeenCalledTimes(2)
    bridge.requestNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(events.map).toHaveBeenCalledTimes(2)
    bridge.close()
  })

  it('keeps unsent offsets right when a long entry is trimmed and old entries are evicted', async () => {
    const { bridge, user, assistant, delegate, mapped } = setup()
    user('a'.repeat(9000)); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect((mapped(0).userWords as string).length).toBe(8000)
    for (let i = 0; i < 30; i++) assistant(`Reply ${i}. `)
    user(' Then this.')
    delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(1)).toMatchObject({ userWords: 'Then this.' })
    bridge.close()
  })

  it('falls back to the user\'s own words when the rewrite repeats the voice assistant', async () => {
    const { bridge, events, user, assistant, delegate } = setup()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    assistant('Do you want me to save your Supabase API key and ask for your project URL?')
    user('You are the new casual greeting agent. Yes.')
    events.map.mockResolvedValueOnce({ text: 'Save my Supabase API key and ask for my project URL.', mode: 'interrupt' })
    delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ text: 'You are the new casual greeting agent. Yes.', mode: 'interrupt' })
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    bridge.close()
  })

  it('keeps a rewrite that quotes the assistant in the user\'s own words', () => {
    const assistant = 'I found three matching files in the workspace folder today.'
    expect(leaksAssistantSpeech('Open the first of the three matching files.', assistant, 'open the first of the three matching files')).toBe(false)
    expect(leaksAssistantSpeech('Yes, three matching files in the workspace folder today.', assistant, 'yes')).toBe(true)
    expect(leaksAssistantSpeech('Anything', '', 'anything')).toBe(false)
  })

  it('lets queued words join the running turn without discarding its replies', async () => {
    const { bridge, events, user, delegate } = setup()
    bridge.setBusy(true)
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    bridge.reply('long reply '.repeat(100))
    await Promise.resolve()
    events.map.mockResolvedValueOnce({ text: 'And also Thursday.', mode: 'queue' })
    user('And also Thursday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ text: 'And also Thursday.', mode: 'queue' })
    resolve({ text: 'Still working on it.' })
    await vi.advanceTimersByTimeAsync(0)
    expect(events.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.commentary.append', content: 'Still working on it.' }))
    bridge.close()
  })

  it('publishes interlaced spoken subtitles that survive an agent handoff', async () => {
    const { bridge, events, user, assistant, delegate } = setup()
    user('Check ')
    const first = events.onTranscript.mock.calls.at(-1)![0]
    user('Friday.')
    assistant("I'll check.")
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
    const { bridge, events, user, assistant, delegate } = setup()
    bridge.setPaused(true)
    assistant('Please connect ')
    assistant('your account.')
    expect(events.onTranscript).toHaveBeenLastCalledWith([{ role: 'assistant', text: 'Please connect your account.' }])
    user('Ignored while paused'); delegate()
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.onUtterance).not.toHaveBeenCalled()
    expect(events.map).not.toHaveBeenCalled()
    bridge.close()
  })

  it('discards an in-flight mapping if the user adds a correction', async () => {
    const { bridge, events, user, delegate, mapped } = setup()
    let resolve!: (value: unknown) => void
    events.map.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    user('Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    const firstSignal = events.map.mock.calls[0][1]
    user(' Actually Thursday.')
    expect(firstSignal.aborted).toBe(true)
    resolve({ text: 'Check Friday.', mode: 'interrupt' })
    await Promise.resolve()
    expect(events.onRequest).not.toHaveBeenCalled()
    events.map.mockResolvedValue({ text: 'Check Thursday.', mode: 'interrupt' })
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(1)).toMatchObject({ userWords: 'Friday. Actually Thursday.' })
    expect(events.onRequest).toHaveBeenCalledExactlyOnceWith({ text: 'Check Thursday.', mode: 'interrupt' })
    bridge.close()
  })

  it('rejects a mapping in the old action shape instead of sending it', async () => {
    const { bridge, events, user, delegate } = setup()
    events.map.mockResolvedValueOnce({ action: 'clarify', text: 'Which day?' })
    user('Check...'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).not.toHaveBeenCalled()
    expect(events.send).not.toHaveBeenCalled()
    expect(events.onError).toHaveBeenCalledOnce()
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

  it('does not arm a future delegation when the mic is pressed without unsent words', async () => {
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
