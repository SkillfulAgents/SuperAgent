// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), mic: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mocks.fetch }))
vi.mock('../../shared/audio-capture', () => ({ acquireMicStream: mocks.mic }))
import { OpenAILiveConversation, LIVE_SPEECH_RELEASE_MS, LIVE_DISCONNECT_GRACE_MS } from './live-session'

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
  const callbacks = { onReady: vi.fn(), onError: vi.fn(), onSpeaking: vi.fn(), onInputSpeaking: vi.fn(), onUtterance: vi.fn(), onRequest: vi.fn(async () => true) }
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
  it('starts on the selected agent route without supplying custom instructions from the browser', async () => {
    const { adapter } = setup('ada display/slug')
    await adapter.start()
    expect(mocks.fetch).toHaveBeenCalledWith('/api/voice/live/agents/ada%20display%2Fslug/session', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ sdp: 'offer', history: [] }),
    }))
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

  it('flushes ordered commentary at coordinator-supplied message boundaries', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.updateReply('First message.', false)
    adapter.nextReplySegment()
    adapter.updateReply('Second message.', true)
    await vi.advanceTimersByTimeAsync(1000)
    const commentary = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.type === 'session.commentary.append')
    expect(commentary.map(event => event.content)).toEqual(['First message.', 'Second message.'])
    adapter.close()
  })

  it('discards buffered speech when the coordinator resets an interrupted reply', async () => {
    const { adapter } = setup()
    await adapter.start()
    const channel = FakePeer.last.channel
    channel.receive({ type: 'session.started' })
    adapter.updateReply('Obsolete response.', false)
    adapter.resetReply()
    adapter.updateReply('Replacement response.', true)
    await vi.advanceTimersByTimeAsync(1000)
    const commentary = channel.send.mock.calls.map(([text]) => JSON.parse(text)).filter(event => event.type === 'session.commentary.append')
    expect(commentary.map(event => event.content)).toEqual(['Replacement response.'])
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
