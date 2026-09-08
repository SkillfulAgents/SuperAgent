import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TranscriptEvent } from './stt'

interface FakeAdapter {
  transcriptCb: ((e: TranscriptEvent) => void) | null
  errorCb: ((e: Error) => void) | null
  connect: ReturnType<typeof vi.fn>
  sendAudio: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  finalize: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onTranscript: (cb: (e: TranscriptEvent) => void) => void
  onError: (cb: (e: Error) => void) => void
  emit: (e: TranscriptEvent) => void
}

const stt = vi.hoisted(() => {
  const adapters: FakeAdapter[] = []
  const captures: Array<{ cleanup: ReturnType<typeof vi.fn>; processor: { onaudioprocess: unknown }; analyser: object }> = []
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = []
  return {
    adapters,
    captures,
    tracks,
    createSttAdapter: vi.fn(() => {
      const adapter: FakeAdapter = {
        transcriptCb: null,
        errorCb: null,
        connect: vi.fn(async () => {}),
        sendAudio: vi.fn(),
        finish: vi.fn(async () => {}),
        finalize: vi.fn(),
        close: vi.fn(),
        onTranscript(cb) {
          adapter.transcriptCb = cb
        },
        onError(cb) {
          adapter.errorCb = cb
        },
        emit(e) {
          adapter.transcriptCb?.(e)
        },
      }
      adapters.push(adapter)
      return adapter
    }),
    acquireMicStream: vi.fn(async () => {
      const track = { stop: vi.fn() }
      tracks.push(track)
      return { getTracks: () => [track] }
    }),
    startAudioCapture: vi.fn(async () => {
      const capture = { cleanup: vi.fn(), processor: { onaudioprocess: null as unknown }, analyser: { fftSize: 256 } }
      captures.push(capture)
      return capture
    }),
    float32ToInt16: (samples: Float32Array) => new Int16Array(samples.length),
  }
})
vi.mock('./stt', () => stt)

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ apiFetch }))

import { VoiceListener } from './voice-listener'

function events() {
  return { onUtterance: vi.fn(), onSpeechStarted: vi.fn(), onSpeechEnded: vi.fn(), onError: vi.fn() }
}

async function started() {
  const ev = events()
  const listener = new VoiceListener(ev)
  await listener.start()
  return { listener, ev, adapter: stt.adapters[stt.adapters.length - 1] }
}

describe('VoiceListener', () => {
  beforeEach(() => {
    stt.adapters.length = 0
    stt.captures.length = 0
    stt.tracks.length = 0
    stt.createSttAdapter.mockClear()
    stt.acquireMicStream.mockClear()
    stt.startAudioCapture.mockClear()
    apiFetch.mockReset()
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ provider: 'deepgram', token: 'jwt' }) })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the mic and a transcription socket, and exposes the level meter', async () => {
    const { listener, adapter } = await started()
    expect(apiFetch).toHaveBeenCalledWith('/api/voice/token')
    expect(adapter.connect).toHaveBeenCalledWith('jwt')
    expect(stt.startAudioCapture).toHaveBeenCalledWith(adapter, expect.anything(), { withAnalyser: true })
    expect(listener.analyser).toBe(stt.captures[0].analyser)
    expect(listener.isRunning).toBe(true)
  })

  it('accumulates finals and the interim tail into one utterance', async () => {
    const { listener, ev, adapter } = await started()
    adapter.emit({ type: 'interim', text: 'hel' })
    expect(ev.onUtterance).toHaveBeenLastCalledWith('hel')
    adapter.emit({ type: 'final', text: 'hello' })
    adapter.emit({ type: 'interim', text: 'wor' })
    expect(listener.utterance).toBe('hello wor')
    adapter.emit({ type: 'final', text: 'world' })
    expect(listener.utterance).toBe('hello world')
    expect(listener.wordCount).toBe(2)
    expect(ev.onUtterance).toHaveBeenLastCalledWith('hello world')
  })

  it('forwards the voice-activity and silence signals', async () => {
    const { ev, adapter } = await started()
    adapter.emit({ type: 'speech_started', text: '' })
    expect(ev.onSpeechStarted).toHaveBeenCalledTimes(1)
    adapter.emit({ type: 'speech_ended', text: '' })
    expect(ev.onSpeechEnded).toHaveBeenCalledTimes(1)
  })

  it('take() asks the server to finalize, includes the finals that follow, then starts afresh', async () => {
    const { listener, ev, adapter } = await started()
    adapter.emit({ type: 'final', text: 'ship' })
    adapter.emit({ type: 'interim', text: 'i' })

    let taken: string | null = null
    const taking = listener.take().then((text) => { taken = text })
    expect(adapter.finalize).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(taken).toBeNull()

    adapter.emit({ type: 'final', text: 'it now' })
    adapter.emit({ type: 'finalized', text: '' })
    await taking
    expect(taken).toBe('ship it now')
    expect(listener.utterance).toBe('')
    expect(ev.onUtterance).toHaveBeenLastCalledWith('')
  })

  it('take() falls back to what it has if the server never answers the finalize', async () => {
    vi.useFakeTimers()
    const { listener, adapter } = await started()
    adapter.emit({ type: 'final', text: 'good enough' })
    const taking = listener.take()
    await vi.advanceTimersByTimeAsync(1_300)
    expect(await taking).toBe('good enough')
  })

  it('discard() drops what was heard', async () => {
    const { listener, adapter } = await started()
    adapter.emit({ type: 'final', text: 'echo of the reply' })
    const discarding = listener.discard()
    adapter.emit({ type: 'finalized', text: '' })
    await discarding
    expect(listener.utterance).toBe('')
  })

  it('reconnects once after the socket drops, keeping the mic and the utterance', async () => {
    const { listener, ev, adapter } = await started()
    adapter.emit({ type: 'final', text: 'so far' })
    adapter.errorCb?.(new Error('socket closed'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(adapter.close).toHaveBeenCalled()
    expect(stt.adapters).toHaveLength(2)
    expect(stt.adapters[1].connect).toHaveBeenCalledWith('jwt')
    expect(ev.onError).not.toHaveBeenCalled()
    expect(listener.utterance).toBe('so far')
    expect(stt.captures).toHaveLength(1)
    expect(listener.isRunning).toBe(true)

    // The new socket carries the transcript on.
    stt.adapters[1].emit({ type: 'final', text: 'and on' })
    expect(listener.utterance).toBe('so far and on')

    // Having carried words, that socket's own drop (much later) gets a
    // reconnect of its own.
    stt.adapters[1].errorCb?.(new Error('gone'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(stt.adapters).toHaveLength(3)
    expect(ev.onError).not.toHaveBeenCalled()
    expect(listener.utterance).toBe('so far and on')

    // A drop before the new socket carried anything is the end of it.
    stt.adapters[2].errorCb?.(new Error('gone again'))
    await Promise.resolve()
    expect(ev.onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'gone again' }))
    expect(listener.isRunning).toBe(false)
    expect(stt.captures[0].cleanup).toHaveBeenCalled()
  })

  it('stop() releases the mic and closes the socket', async () => {
    const { listener, adapter } = await started()
    listener.stop()
    expect(stt.captures[0].cleanup).toHaveBeenCalledTimes(1)
    expect(adapter.close).toHaveBeenCalledTimes(1)
    expect(listener.isRunning).toBe(false)
    expect(listener.analyser).toBeNull()
  })

  it('a stop during start-up releases what start acquired', async () => {
    type MicStream = Awaited<ReturnType<typeof stt.acquireMicStream>>
    let release: (value: MicStream) => void = () => {}
    stt.acquireMicStream.mockImplementationOnce(() => new Promise<MicStream>((resolve) => { release = resolve }))
    const listener = new VoiceListener(events())
    const starting = listener.start()
    await Promise.resolve()
    await Promise.resolve()
    listener.stop()
    const track = { stop: vi.fn() }
    release({ getTracks: () => [track] })
    await starting
    expect(track.stop).toHaveBeenCalled()
    expect(stt.startAudioCapture).not.toHaveBeenCalled()
    expect(stt.adapters[0].close).toHaveBeenCalled()
  })

  it('a refused token surfaces as the start error', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Voice is not configured' }) })
    const listener = new VoiceListener(events())
    await expect(listener.start()).rejects.toThrow('Voice is not configured')
    expect(listener.isRunning).toBe(false)
  })
})
