import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAILiveBridge, leaksAssistantSpeech, liveTextChunks } from './live-bridge'
import { LIVE_TURN_COMPLETE_CUE } from '@shared/lib/voice/live-types'

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

  it('accepts an older host\'s action answers: message and cancel send, clarify keeps the words, none drops them', async () => {
    const { bridge, events, user, delegate, mapped } = setup()
    events.map.mockResolvedValueOnce({ action: 'clarify', text: 'Which day?' })
    user('Check...'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'session.commentary.append', delegation_id: 'item_1', content: 'Clarification needed: Which day?' }))
    expect(events.onRequest).not.toHaveBeenCalled()
    events.map.mockResolvedValueOnce({ action: 'message', text: 'Check Friday.' })
    user(' Friday.'); delegate('item_2')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(1)).toMatchObject({ userWords: 'Check... Friday.' })
    expect(events.onRequest).toHaveBeenLastCalledWith({ text: 'Check Friday.', mode: 'interrupt' })
    events.map.mockResolvedValueOnce({ action: 'none', text: '' })
    user('Thanks.'); delegate('item_3')
    await vi.advanceTimersByTimeAsync(700)
    events.map.mockResolvedValueOnce({ action: 'cancel', text: '' })
    user('Stop that.'); delegate('item_4')
    await vi.advanceTimersByTimeAsync(700)
    expect(mapped(3)).toMatchObject({ userWords: 'Stop that.' })
    expect(events.onRequest).toHaveBeenLastCalledWith({ text: 'Stop that.', mode: 'interrupt' })
    expect(events.onRequest).toHaveBeenCalledTimes(2)
    expect(events.onError).not.toHaveBeenCalled()
    bridge.close()
  })

  it('reports a mapping in neither shape instead of sending it', async () => {
    const { bridge, events, user, delegate } = setup()
    events.map.mockResolvedValueOnce({ verdict: 'send' })
    user('Check Friday.'); delegate()
    await vi.advanceTimersByTimeAsync(700)
    expect(events.onRequest).not.toHaveBeenCalled()
    expect(events.onError).toHaveBeenCalledOnce()
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
    expect(sent).toHaveLength(3) // Logical appends stay whole until the transport is ready.
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
    expect(sent.filter(event => event.type === 'session.thinking.append').map(event => event.content).join('')).toBe(result.trim())
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

  it('tags a paused cue for deferred transport delivery and invalidates it independently of text', async () => {
    const { bridge, events } = setup()
    bridge.reply('The draft needs approval.')
    bridge.completeReply()
    bridge.setPaused(true)
    await vi.advanceTimersByTimeAsync(0)
    const [reply, cue] = events.send.mock.calls
    expect(reply[1]).toMatchObject({ kind: 'reply' })
    expect(cue[1]).toMatchObject({ kind: 'completion' })
    expect(cue[1].isCurrent()).toBe(true)
    bridge.cancelCompletion()
    expect(cue[1].isCurrent()).toBe(false)
    expect(reply[1].isCurrent()).toBe(true)
    bridge.close()
  })

  it('preserves every prose fact without markdown when condensation fails', async () => {
    const { bridge, events } = setup()
    events.map.mockRejectedValueOnce(new Error('Unavailable'))
    const text = '# Invoice\n**Invoice 42 was sent.**\n' + '- Still reconciling.\n'.repeat(80) + '\nPayment failed. Do not resend.'
    bridge.reply(text)
    await vi.advanceTimersByTimeAsync(0)
    const content = events.send.mock.calls[0][0].content
    expect(content).toContain('Invoice 42 was sent.')
    expect(content).toContain('Payment failed. Do not resend.')
    expect(content).not.toMatch(/[#*]/)
    expect(events.send).toHaveBeenCalledOnce()
    bridge.close()
  })

  it('reports delivery failure separately and allows subsequent replies through', async () => {
    const { bridge, events } = setup()
    events.send.mockImplementationOnce(() => { throw new Error('Transport unavailable') })
    bridge.reply('First result.')
    bridge.reply('Second result.')
    await vi.advanceTimersByTimeAsync(0)
    expect(events.onError).toHaveBeenCalledWith('Transport unavailable')
    expect(events.send.mock.calls.at(-1)![0].content).toBe('Second result.')
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
