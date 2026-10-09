// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), mic: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.fetch }))
vi.mock('../../shared/audio-capture', () => ({ acquireMicStream: mocks.mic }))
import { OpenAILiveConversation, LIVE_SPEECH_RELEASE_MS, LIVE_DISCONNECT_GRACE_MS } from './live-session'
import { LIVE_TURN_COMPLETE_CUE } from '@shared/lib/voice/live-types'

class FakeChannel {
  readyState = 'open'
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  send = vi.fn()
  close = vi.fn()
  receive(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }) }
}
class FakePeer {
  static last: FakePeer
  channel = new FakeChannel()
  ontrack: ((event: { track: unknown }) => void) | null = null
  connectionState = 'connected'
  onconnectionstatechange: (() => void) | null = null
  iceGatheringState = 'complete'
  localDescription = { sdp: 'offer' }
  createDataChannel = () => this.channel
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer' }))
  setLocalDescription = vi.fn(async () => {})
  setRemoteDescription = vi.fn(async () => {})
  addTrack = vi.fn()
  close = vi.fn()
  constructor() { FakePeer.last = this }
}
class FakeAudioContext {
  static outputLevel = 0
  static inputLevel = 0
  private analyserCount = 0

  resume = vi.fn(async () => {})
  close = vi.fn(async () => {})
  createAnalyser = () => {
    const input = this.analyserCount++ === 0
    return {
      fftSize: 256,
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(input ? FakeAudioContext.inputLevel : FakeAudioContext.outputLevel),
    }
  }
  createMediaStreamSource = () => ({ connect: vi.fn() })
}
const track = { enabled: true, stop: vi.fn() }
function setup(agentSlug?: string) {
  const callbacks = { onReady: vi.fn(), onClosed: vi.fn(), onError: vi.fn(), onSpeaking: vi.fn(), onInputSpeaking: vi.fn(), onUtterance: vi.fn(), onRequest: vi.fn(async () => true) }
  return { adapter: new OpenAILiveConversation(callbacks, [], agentSlug), callbacks }
}
const answer = () => new Response(JSON.stringify({ session: { id: 'live_1' }, transport: { sdp: 'answer' }, handle: 'owned-handle' }))
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  vi.stubGlobal('RTCPeerConnection', FakePeer)
  vi.stubGlobal('AudioContext', FakeAudioContext)
  FakeAudioContext.outputLevel = 0
  FakeAudioContext.inputLevel = 0
  vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
  mocks.mic.mockResolvedValue({ getAudioTracks: () => [track], getTracks: () => [track] })
  mocks.fetch.mockImplementation(async (path: string) => path.endsWith('/session') ? answer() : new Response('{}'))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Live WebRTC lifecycle', () => {
  it('flushes text at a message boundary without announcing completion', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.updateReply('I started the background research.', true)
    await vi.advanceTimersByTimeAsync(0)
    const sent = channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(sent.some(e => e.content === 'I started the background research.' && e.type === 'session.thinking.append')).toBe(true)
    expect(sent.some(e => e.content === LIVE_TURN_COMPLETE_CUE)).toBe(false)
    adapter.close()
  })

  it('releases the pause guard when microphone gating throws', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    const gate = vi.spyOn(adapter as unknown as { gateMicrophone(): void }, 'gateMicrophone')
      .mockImplementationOnce(() => { throw new Error('Track detached') })
    expect(() => adapter.setPaused(true)).toThrow('Track detached')
    gate.mockRestore()
    adapter.setPaused(false)
    adapter.updateReply('Recovered.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(channel.send.mock.calls.map(([text]) => JSON.parse(text)).some(e => e.content === LIVE_TURN_COMPLETE_CUE)).toBe(true)
    adapter.close()
  })

  it('announces each new input request once while paused, without reopening the mic or submitting an answer', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.setPaused(true)
    channel.send.mockClear()
    const question = { id: 'question:1', message: 'The agent needs a database choice in the question card.' }
    const secret = { id: 'secret:2', message: 'The agent needs an API key in the secret card.' }
    const announcements = () => channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.type === 'session.commentary.append')
    adapter.setInputRequests([question])
    adapter.setInputRequests([{ ...question }])
    adapter.setInputRequests([question, secret])
    expect(announcements().map(event => event.content)).toEqual([
      `Application input request: ${question.message}`,
      `Application input request: ${secret.message}`,
    ])
    expect(track.enabled).toBe(false)
    expect(adapter['audio']?.muted).toBe(false)
    expect(callbacks.onRequest).not.toHaveBeenCalled()
    // Removing cards or replaying a snapshot must not repeat the announcement.
    adapter.setInputRequests([])
    adapter.setInputRequests([secret])
    expect(announcements()).toHaveLength(2)
    adapter.close()
    adapter.setInputRequests([{ id: 'question:3', message: 'Too late.' }])
    expect(announcements()).toHaveLength(2)
  })

  it('announces only still-pending requests when the voice connection becomes ready', async () => {
    const { adapter } = setup()
    adapter.setPaused(true)
    adapter.setInputRequests([{ id: 'old', message: 'Already answered.' }])
    await adapter.start()
    const channel = FakePeer.last.channel
    const current = { id: 'current', message: 'Connect a calendar account in the application.' }
    adapter.setInputRequests([current])
    expect(channel.send).not.toHaveBeenCalled()
    channel.receive({ type: 'session.started' })
    const sent = channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(sent.filter(event => event.type === 'session.commentary.append').map(event => event.content)).toEqual([
      `Application input request: ${current.message}`,
    ])
    expect(sent.at(-1).type).toBe('session.commentary.append')
    expect(track.enabled).toBe(false)
    adapter.close()
  })

  it('starts on the selected agent route without supplying custom instructions from the browser', async () => {
    const { adapter } = setup('ada display/slug')
    await adapter.start()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/agents/ada%20display%2Fslug/session', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sdp: 'offer', history: [] }),
    }))
    adapter.close()
  })

  it('asks for the microphone before resuming audio, which Safari holds without a gesture', async () => {
    // A session opened from the agent home starts with no user gesture: Safari
    // leaves resume() pending until the page is capturing.
    let capturing = false
    mocks.mic.mockImplementation(async () => {
      capturing = true
      return { getAudioTracks: () => [track], getTracks: () => [track] }
    })
    vi.stubGlobal('AudioContext', class extends FakeAudioContext {
      resume = vi.fn(() => capturing ? Promise.resolve() : new Promise<void>(() => {}))
    })
    const { adapter } = setup()
    await adapter.start()
    expect(mocks.mic).toHaveBeenCalledOnce()
    expect(FakePeer.last.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' })
    adapter.close()
  })

  it('waits for session.started and never sends the WebSocket session.start command', async () => {
    const { adapter, callbacks } = setup()
    adapter.setPaused(true)
    await adapter.start()
    const peer = FakePeer.last
    expect(peer.setRemoteDescription).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' })
    expect(peer.channel.send).not.toHaveBeenCalled()
    expect(callbacks.onReady).not.toHaveBeenCalled()
    peer.channel.receive({ type: 'session.started' })
    expect(callbacks.onReady).toHaveBeenCalledOnce()
    expect(track.enabled).toBe(false)
    expect(peer.channel.send.mock.calls.map(([text]) => JSON.parse(text).type)).not.toContain('session.start')
    adapter.close()
    expect(track.stop).toHaveBeenCalled()
    expect(peer.close).not.toHaveBeenCalled()
    peer.channel.receive({ type: 'session.closed' })
    expect(peer.close).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/session/owned-handle', expect.objectContaining({ method: 'DELETE' }))
  })

  it('holds the speaking indicator through quiet speech and sentence gaps, then releases on silence', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    FakePeer.last.channel.receive({ type: 'session.started' })
    FakePeer.last.ontrack?.({ track: {} })
    await vi.advanceTimersByTimeAsync(100)
    expect(callbacks.onSpeaking).not.toHaveBeenCalled()
    FakeAudioContext.outputLevel = 0.008
    await vi.advanceTimersByTimeAsync(20)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true]])
    FakeAudioContext.outputLevel = 0
    await vi.advanceTimersByTimeAsync(800)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true]])
    FakeAudioContext.outputLevel = 0.008
    await vi.advanceTimersByTimeAsync(40)
    FakeAudioContext.outputLevel = 0
    await vi.advanceTimersByTimeAsync(LIVE_SPEECH_RELEASE_MS)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true], [false]])
    adapter.close()
  })

  it('keeps the reply audible and reported while paused for a request card, muting only the mic', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    FakePeer.last.ontrack?.({ track: {} })
    FakeAudioContext.outputLevel = 0.1
    await vi.advanceTimersByTimeAsync(20)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true]])
    channel.send.mockClear()
    adapter.setPaused(true)
    await vi.advanceTimersByTimeAsync(20)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true]])
    expect(track.enabled).toBe(false)
    expect(adapter['audio']?.muted).toBe(false)
    const sent = channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(sent.map((event) => event.type)).toEqual(['session.input_audio.mute', 'session.instructions.append'])
    expect(sent[1].content).toContain('Finish what you are saying')
    FakeAudioContext.outputLevel = 0
    await vi.advanceTimersByTimeAsync(LIVE_SPEECH_RELEASE_MS)
    expect(callbacks.onSpeaking.mock.calls).toEqual([[true], [false]])
    adapter.setPaused(false)
    expect(track.enabled).toBe(true)

    // The person's own mute is separate from the card's pause: releasing
    // the pause does not reopen a muted mic, and Live is told each time.
    channel.send.mockClear()
    adapter.setMicrophoneMuted(true)
    expect(track.enabled).toBe(false)
    adapter.setPaused(true)
    adapter.setPaused(false)
    expect(track.enabled).toBe(false)
    adapter.setMicrophoneMuted(false)
    expect(track.enabled).toBe(true)
    const gated = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter((event) => String(event.type).startsWith('session.input_audio'))
    expect(gated.map((event) => event.type)).toEqual(['session.input_audio.mute', 'session.input_audio.mute', 'session.input_audio.mute', 'session.input_audio.unmute'])
    adapter.close()
  })

  it('a mute set while connecting holds on the track it opens', async () => {
    const { adapter } = setup()
    adapter.setMicrophoneMuted(true)
    await adapter.start()
    expect(track.enabled).toBe(false)
    adapter.close()
  })

  it('ignores microphone noise and cuts on recognized input words only', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    FakeAudioContext.inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(2000)
    channel.receive({ type: 'session.input_transcript.delta', delta: ' ... ' })
    channel.receive({ type: 'session.output_transcript.delta', delta: 'An assistant subtitle.' })
    expect(callbacks.onInputSpeaking).not.toHaveBeenCalled()
    expect(callbacks.onSpeaking).not.toHaveBeenCalled()

    FakeAudioContext.inputLevel = 0
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Wait' })
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    expect(callbacks.onUtterance).toHaveBeenLastCalledWith(' ... Wait')
    await vi.advanceTimersByTimeAsync(800)
    channel.receive({ type: 'session.input_transcript.delta', delta: ' 请等一下' })
    await vi.advanceTimersByTimeAsync(800)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    channel.receive({ type: 'session.input_transcript.delta', delta: '.' })
    await vi.advanceTimersByTimeAsync(400)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    // Speaker leakage after music resumes cannot reopen the gate.
    FakeAudioContext.inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(2000)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    adapter.close()
  })

  it('keeps confirmed speech active through delayed transcription until the microphone falls silent', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Please' })
    FakeAudioContext.inputLevel = 0.02
    // No more words arrive, but the user continues speaking for five seconds.
    await vi.advanceTimersByTimeAsync(5000)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    FakeAudioContext.inputLevel = 0
    await vi.advanceTimersByTimeAsync(800)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    await vi.advanceTimersByTimeAsync(400)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    // Once released, only another recognized word can stop music again.
    FakeAudioContext.inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(2000)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Actually' })
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false], [true]])
    adapter.close()
  })

  it('resets confirmed input when the assistant starts speaking and accepts fresh interruptions', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    FakePeer.last.ontrack?.({ track: {} })
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Hello' })
    FakeAudioContext.inputLevel = 0.1
    await vi.advanceTimersByTimeAsync(2000)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    // Text arriving ahead of playback does not count as an audible response.
    channel.receive({ type: 'session.output_transcript.delta', delta: 'Hi there' })
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true]])
    FakeAudioContext.outputLevel = 0.02
    await vi.advanceTimersByTimeAsync(20)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    expect(callbacks.onSpeaking).toHaveBeenLastCalledWith(true)
    expect(callbacks.onSpeaking.mock.invocationCallOrder[0]).toBeLessThan(callbacks.onInputSpeaking.mock.invocationCallOrder[1])
    // Playback leakage cannot re-latch input, but new words can interrupt.
    await vi.advanceTimersByTimeAsync(2000)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Wait' })
    await vi.advanceTimersByTimeAsync(100)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false], [true]])
    adapter.close()
  })

  it('clears transcript speech on pause and close without replaying old words', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    FakeAudioContext.inputLevel = 0.1
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Hello' })
    adapter.setPaused(true)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Ignored while paused' })
    adapter.setPaused(false)
    await vi.advanceTimersByTimeAsync(LIVE_SPEECH_RELEASE_MS)
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false]])
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Again' })
    adapter.close()
    expect(callbacks.onInputSpeaking.mock.calls).toEqual([[true], [false], [true], [false]])
    callbacks.onInputSpeaking.mockClear()
    channel.receive({ type: 'session.input_transcript.delta', delta: 'Ignored after close' })
    await vi.advanceTimersByTimeAsync(LIVE_SPEECH_RELEASE_MS)
    expect(callbacks.onInputSpeaking).not.toHaveBeenCalled()
  })

  it('streams thinking across message boundaries and sends one completion cue even with no final text delta', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.updateReply('First message.', false)
    adapter.nextReplySegment()
    adapter.updateReply('Second message.', false)
    await vi.advanceTimersByTimeAsync(1000)
    const replies = () => channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event =>
      event.type === 'session.thinking.append' || event.type === 'session.commentary.append')
    expect(replies()).toMatchObject([
      { type: 'session.thinking.append', content: 'First message.' },
      { type: 'session.thinking.append', content: 'Second message.' },
    ])
    adapter.updateReply('Second message.', true)
    adapter.finishTurn('completed')
    adapter.updateReply('Second message.', true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(replies()).toMatchObject([
      { type: 'session.thinking.append', content: 'First message.' },
      { type: 'session.thinking.append', content: 'Second message.' },
      { type: 'session.commentary.append', content: LIVE_TURN_COMPLETE_CUE },
    ])
    adapter.close()
  })

  it.each([
    { complete: false, ready: true },
    { complete: true, ready: true },
    { complete: true, ready: false },
  ])('discards buffered text and queued cues when resetting a reply (complete: $complete, ready: $ready)', async ({ complete, ready }) => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    if (ready) channel.receive({ type: 'session.started' })
    adapter.updateReply('Obsolete response.', complete)
    if (complete) adapter.finishTurn('completed')
    if (!ready) await vi.advanceTimersByTimeAsync(0)
    adapter.resetReply()
    adapter.updateReply('Replacement response.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(1000)
    if (!ready) channel.receive({ type: 'session.started' })
    const replies = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event =>
      event.type === 'session.thinking.append' || event.type === 'session.commentary.append')
    expect(replies).toMatchObject([
      { type: 'session.thinking.append', content: 'Replacement response.' },
      { type: 'session.commentary.append', content: LIVE_TURN_COMPLETE_CUE },
    ])
    adapter.close()
  })

  it('holds a completion queued before connection until the request card resumes', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    adapter.updateReply('The draft needs approval.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    adapter.setPaused(true)
    adapter.setInputRequests([{ id: 'approval:1', message: 'Approve the $12 cost in the app.' }])
    channel.receive({ type: 'session.started' })
    const commentary = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.type === 'session.commentary.append')
    expect(commentary.map(event => event.content)).toEqual(['Application input request: Approve the $12 cost in the app.'])
    adapter.setPaused(false)
    adapter.setPaused(false)
    const resumed = channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(resumed.filter(event => event.content === LIVE_TURN_COMPLETE_CUE)).toHaveLength(1)
    const cueIndex = resumed.findIndex(event => event.content === LIVE_TURN_COMPLETE_CUE)
    expect(resumed.slice(0, cueIndex).some(event => event.content?.includes('ready for voice conversation'))).toBe(true)
    adapter.close()
  })

  it('delivers partial work before an execution error and discards only completion', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.updateReply('Invoice 42 was sent.', true)
    adapter.finishTurn('completed')
    adapter.reportAgentError('Signing service unavailable.')
    await vi.advanceTimersByTimeAsync(1000)
    const replies = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event =>
      event.type === 'session.thinking.append' || event.type === 'session.commentary.append')
    expect(replies).toMatchObject([
      { type: 'session.thinking.append', content: 'Invoice 42 was sent.' },
      { type: 'session.commentary.append', content: 'The agent reported an error: Signing service unavailable.' },
    ])
    adapter.updateReply('Recovered.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    const recovered = channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(recovered.at(-2).content).toBe('Recovered.')
    expect(recovered.at(-1).content).toBe(LIVE_TURN_COMPLETE_CUE)
    adapter.close()
  })

  it('closes a billable session whose creation finishes after the user exits', async () => {
    let finish!: (response: Response) => void
    mocks.fetch.mockImplementation((path: string) => path.endsWith('/session') ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(new Response('{}')))
    const { adapter, callbacks } = setup()
    const pending = adapter.start()
    await vi.advanceTimersByTimeAsync(0)
    adapter.close()
    finish(answer())
    await pending
    expect(FakePeer.last.setRemoteDescription).not.toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/session/owned-handle', expect.objectContaining({ method: 'DELETE' }))
    expect(callbacks.onReady).not.toHaveBeenCalled()
  })

  it.each([false, true])('keeps buffered and in-flight facts ahead of an error (summarizing: %s)', async (summarizing) => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    let finish!: (value: Response) => void
    let signal: AbortSignal | undefined
    mocks.fetch.mockImplementation((path: string, options?: RequestInit) => {
      if (path.endsWith('/map')) {
        signal = options?.signal as AbortSignal
        return new Promise(resolve => { finish = resolve })
      }
      return Promise.resolve(new Response('{}'))
    })
    adapter.updateReply(summarizing ? 'Invoice 42 was sent. '.repeat(80) : 'Invoice 42 was sent.')
    if (summarizing) await vi.advanceTimersByTimeAsync(0)
    adapter.reportAgentError('Receipt upload failed.')
    if (summarizing) {
      expect(signal?.aborted).toBe(false)
      finish(new Response(JSON.stringify({ text: 'Invoice 42 was sent.' })))
    }
    await vi.advanceTimersByTimeAsync(1000)
    const sent = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.content && event.type !== 'session.instructions.append')
    expect(sent.map(event => event.content)).toEqual(['Invoice 42 was sent.', 'The agent reported an error: Receipt upload failed.'])
    adapter.close()
  })

  it.each([false, true])('cues a late final answer, coalescing an undelivered cue (ready: %s)', async (ready) => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    if (ready) channel.receive({ type: 'session.started' })
    adapter.updateReply('The draft is saved.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    adapter.updateReply('The draft is saved. Nothing was sent.', true)
    adapter.finishTurn('completed')
    adapter.updateReply('The draft is saved. Nothing was sent.', true)
    await vi.advanceTimersByTimeAsync(0)
    if (!ready) channel.receive({ type: 'session.started' })
    const sent = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.type === 'session.thinking.append' || event.type === 'session.commentary.append')
    expect(sent.filter(event => event.content === LIVE_TURN_COMPLETE_CUE)).toHaveLength(ready ? 2 : 1)
    expect(sent.at(-2).content).toBe(' Nothing was sent.')
    expect(sent.at(-1).content).toBe(LIVE_TURN_COMPLETE_CUE)
    adapter.close()
  })

  it.each([false, true])('retains a cue whose summary finishes while paused unless new work supersedes it (superseded: %s)', async (superseded) => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    let finish!: (value: Response) => void
    mocks.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    adapter.updateReply('Detailed findings. '.repeat(100), true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    adapter.setPaused(true)
    finish(new Response(JSON.stringify({ text: 'The draft was saved.' })))
    await vi.advanceTimersByTimeAsync(0)
    const cues = () => channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.content === LIVE_TURN_COMPLETE_CUE)
    expect(cues()).toHaveLength(0)
    if (superseded) adapter.updateReply('Detailed findings. '.repeat(100) + ' Checking the signature.')
    adapter.setPaused(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(cues()).toHaveLength(superseded ? 0 : 1)
    adapter.close()
  })

  it('keeps more than 128 wire chunks, pause instructions and the cue when summarization fails during startup', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    mocks.fetch.mockRejectedValue(new Error('Summarizer unavailable'))
    // Five separate 12k segments previously exhausted the 128-command queue.
    for (let index = 0; index < 5; index++) {
      adapter.updateReply(`**Invoice ${index} sent.** ` + 'Reconciliation pending. '.repeat(490) + ` End ${index}.`)
      adapter.nextReplySegment()
    }
    adapter.updateReply('Payment failed. Do not resend invoices.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    adapter.setPaused(true)
    channel.receive({ type: 'session.started' })
    const sent = () => channel.send.mock.calls.map(([text]) => JSON.parse(text))
    const context = sent().filter(event => event.type === 'session.thinking.append')
    expect(context.length).toBeGreaterThan(128)
    for (let index = 0; index < 5; index++) {
      expect(context.map(event => event.content).join('')).toContain(`Invoice ${index} sent.`)
      expect(context.map(event => event.content).join('')).toContain(`End ${index}.`)
    }
    expect(context.map(event => event.content).join('')).not.toContain('**')
    expect(sent().some(event => event.type === 'session.input_audio.mute')).toBe(true)
    expect(sent().some(event => event.content?.includes('waiting for user input'))).toBe(true)
    expect(sent().some(event => event.content === LIVE_TURN_COMPLETE_CUE)).toBe(false)
    adapter.setPaused(false)
    expect(sent().filter(event => event.content === LIVE_TURN_COMPLETE_CUE)).toHaveLength(1)
    expect(sent().filter(event => typeof event.content === 'string').every(event => new TextEncoder().encode(event.content).length <= 400)).toBe(true)
    adapter.close()
  })

  it('reports buffer exhaustion instead of silently dropping outcome or control messages', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    // No summarization: this is the maximum backlog from small streamed updates.
    for (let index = 0; index < 700; index++) {
      adapter.updateReply('A'.repeat(500))
      adapter.nextReplySegment()
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('exceeded the connection buffer'))
    expect(callbacks.onClosed).toHaveBeenCalledOnce()
    expect(FakePeer.last.channel.send).not.toHaveBeenCalled()
  })

  it('uses delivery metadata rather than cue wording when resetting and pausing', async () => {
    const { adapter } = setup()
    await adapter.start()
    adapter['bridge'].commentary(LIVE_TURN_COMPLETE_CUE)
    adapter.resetReply()
    adapter.setPaused(true)
    FakePeer.last.channel.receive({ type: 'session.started' })
    const sent = FakePeer.last.channel.send.mock.calls.map(([text]) => JSON.parse(text))
    expect(sent.filter(event => event.content === LIVE_TURN_COMPLETE_CUE)).toHaveLength(1)
    adapter.close()
  })

  it('reports a transport failure and closes even when the close command also fails', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    FakePeer.last.channel.receive({ type: 'session.started' })
    FakePeer.last.channel.send.mockImplementation(() => { throw new Error('Transport unavailable') })
    adapter.updateReply('Invoice 42 sent.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Could not deliver voice updates'))
    expect(callbacks.onClosed).toHaveBeenCalledOnce()
    expect(FakePeer.last.close).toHaveBeenCalledOnce()
  })

  it('retracts a buffered cue when background work wakes even without new text', async () => {
    const { adapter } = setup()
    await adapter.start()
    adapter.updateReply('Partial result.', true)
    adapter.finishTurn('completed')
    await vi.advanceTimersByTimeAsync(0)
    adapter.setBusy(true)
    FakePeer.last.channel.receive({ type: 'session.started' })
    expect(FakePeer.last.channel.send.mock.calls.map(([text]) => JSON.parse(text).content)).not.toContain(LIVE_TURN_COMPLETE_CUE)
    adapter.close()
  })

  it('releases the microphone and host session if Live never starts', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('did not start'))
    expect(track.stop).toHaveBeenCalled()
    expect(FakePeer.last.close).toHaveBeenCalled()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/session/owned-handle', expect.objectContaining({ method: 'DELETE' }))
  })
  it('releases the host handle immediately on pagehide without waiting for close acknowledgment', async () => {
    const { adapter } = setup()
    await adapter.start()
    FakePeer.last.channel.receive({ type: 'session.started' })
    window.dispatchEvent(new Event('pagehide'))
    expect(FakePeer.last.close).toHaveBeenCalledOnce()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/session/owned-handle', expect.objectContaining({ method: 'DELETE', keepalive: true }))
    const count = mocks.fetch.mock.calls.length
    window.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
  })

  it('allows transient WebRTC disconnects to recover and closes sustained failures', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    const peer = FakePeer.last
    peer.channel.receive({ type: 'session.started' })
    peer.connectionState = 'disconnected'
    peer.onconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(LIVE_DISCONNECT_GRACE_MS - 1)
    expect(callbacks.onError).not.toHaveBeenCalled()
    peer.connectionState = 'connected'
    peer.onconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(LIVE_DISCONNECT_GRACE_MS)
    expect(callbacks.onError).not.toHaveBeenCalled()
    peer.connectionState = 'disconnected'
    peer.onconnectionstatechange?.()
    await vi.advanceTimersByTimeAsync(LIVE_DISCONNECT_GRACE_MS)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('connection lost'))
    adapter.close()
  })

  it('closes terminal failures immediately and reports non-JSON API errors clearly', async () => {
    const { adapter, callbacks } = setup()
    await adapter.start()
    FakePeer.last.connectionState = 'failed'
    FakePeer.last.onconnectionstatechange?.()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('connection lost'))
    mocks.fetch.mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
    const second = setup()
    await second.adapter.start()
    expect(second.callbacks.onError).toHaveBeenCalledWith('Could not connect OpenAI Live (502).')
    adapter.close()
    second.adapter.close()
  })

  it('warns before the server lease expires and cancels the warning on close', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ session: { id: 'live_1' }, transport: { sdp: 'answer' }, handle: 'owned-handle', expiresAt: Date.now() + 120_000 })))
    const { adapter, callbacks } = setup()
    await adapter.start()
    FakePeer.last.channel.receive({ type: 'session.started' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.stringContaining('expires in one minute'))
    adapter.close()
  })

})
