// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SttAdapter, SttSessionStats, TranscriptCallback, ErrorCallback } from '@renderer/lib/stt'

const reporting = vi.hoisted(() => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
  addRendererBreadcrumb: vi.fn(),
}))
vi.mock('@renderer/lib/error-reporting', () => reporting)

const stt = vi.hoisted(() => ({
  acquireMicStream: vi.fn(),
  createSttAdapter: vi.fn(),
  startAudioCapture: vi.fn(),
}))
vi.mock('@renderer/lib/stt', () => stt)

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => api)

vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: vi.fn() }),
}))

import { useVoiceInput } from './use-voice-input'

/** A speech adapter whose socket never opens unless the test says so. */
class FakeAdapter implements SttAdapter {
  readonly sampleRate = 24000
  readonly stats: SttSessionStats = {
    socketOpened: false,
    bytesReceived: 0,
    bytesSent: 0,
    bytesDropped: 0,
    peakSample: 0,
    serverEvents: {},
    interims: 0,
    finals: 0,
    errors: 0,
  }
  transcriptCb: TranscriptCallback | null = null
  errorCb: ErrorCallback | null = null
  connectResult: Promise<void> = new Promise(() => {})
  connect = vi.fn(() => this.connectResult)
  sendAudio = vi.fn()
  onTranscript(cb: TranscriptCallback) { this.transcriptCb = cb }
  onError(cb: ErrorCallback) { this.errorCb = cb }
  finish = vi.fn(async () => {})
  finalize = vi.fn()
  close = vi.fn()

  /** As if this many seconds of speech (or silence) had gone through. */
  heard(seconds: number, peakSample: number) {
    this.stats.bytesReceived = this.sampleRate * 2 * seconds
    this.stats.peakSample = peakSample
  }
}

const stream = {
  getAudioTracks: () => [{
    label: 'Built-in Microphone',
    enabled: true,
    muted: false,
    readyState: 'live',
    getSettings: () => ({ sampleRate: 48000, channelCount: 1 }),
  }],
  getTracks: () => [{ stop: vi.fn() }],
} as unknown as MediaStream

function arrange(adapter: FakeAdapter) {
  api.apiFetch.mockResolvedValue({ ok: true, json: async () => ({ provider: 'openai', token: 'ephemeral' }) })
  stt.acquireMicStream.mockResolvedValue(stream)
  stt.createSttAdapter.mockReturnValue(adapter)
  stt.startAudioCapture.mockResolvedValue({
    stream,
    audioContext: { sampleRate: 24000 },
    analyser: {},
    captureKind: 'worklet',
    setSink: vi.fn(),
    cleanup: vi.fn(),
  })
  const onTranscriptUpdate = vi.fn()
  const hook = renderHook(() => useVoiceInput({ onTranscriptUpdate }))
  return { hook, onTranscriptUpdate }
}

/**
 * Kick off in one synchronous act so the 'connecting' render lands before the
 * credential round-trip resolves (as it does against a real network), then
 * let the rest of the start-up settle.
 */
async function start(hook: ReturnType<typeof arrange>['hook']) {
  let pending!: Promise<void>
  act(() => { pending = hook.result.current.startRecording('') })
  await act(async () => { await pending })
}

async function startRecording(hook: ReturnType<typeof arrange>['hook']) {
  await start(hook)
  expect(hook.result.current.isRecording).toBe(true)
}

async function stop(hook: ReturnType<typeof arrange>['hook']) {
  await act(async () => { await hook.result.current.stopRecording() })
}

describe('useVoiceInput error reports', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports a session that heard speech, never opened its socket, and produced no words', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await stop(hook)

    expect(reporting.captureRendererMessage).toHaveBeenCalledTimes(1)
    const [message, context] = reporting.captureRendererMessage.mock.calls[0]
    expect(message).toBe('Dictation ended without a transcript (attempt 1)')
    expect(context.fingerprint).toEqual(['dictation', 'no-transcript'])
    expect(context.tags).toEqual({
      feature: 'dictation',
      stage: 'no_transcript',
      provider: 'openai',
      socket: 'never_opened',
      audio: 'audible',
      capture: 'worklet',
    })
    expect(context.extra).toMatchObject({
      provider: 'openai',
      captureKind: 'worklet',
      contextSampleRate: 24000,
      bytesReceived: 24000 * 2 * 4,
      peakSample: 9000,
      track: { label: 'Built-in Microphone', muted: false },
    })
    expect(reporting.captureRendererException).not.toHaveBeenCalled()
  })

  it('numbers retries so consecutive reports are not collapsed as duplicates, under one fingerprint', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await stop(hook)
    const retry = new FakeAdapter()
    stt.createSttAdapter.mockReturnValue(retry)
    await startRecording(hook)
    retry.heard(4, 9000)
    await stop(hook)

    const messages = reporting.captureRendererMessage.mock.calls.map(([m]) => m)
    expect(messages).toEqual([
      'Dictation ended without a transcript (attempt 1)',
      'Dictation ended without a transcript (attempt 2)',
    ])
    const fingerprints = reporting.captureRendererMessage.mock.calls.map(([, c]) => c.fingerprint)
    expect(fingerprints[0]).toEqual(fingerprints[1])
    expect(reporting.captureRendererMessage.mock.calls[1][1].extra).toMatchObject({ attempt: 2 })
  })

  it('tells silence from the mic apart from speech the server ignored', async () => {
    const adapter = new FakeAdapter()
    adapter.stats.socketOpened = true
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 12)
    await stop(hook)

    expect(reporting.captureRendererMessage.mock.calls[0][1].tags).toMatchObject({ socket: 'opened', audio: 'silent' })
  })

  it('stays quiet about a tap too short to have been an attempt', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(0.5, 9000)
    await stop(hook)

    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('stays quiet when words came back', async () => {
    const adapter = new FakeAdapter()
    const { hook, onTranscriptUpdate } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    act(() => { adapter.transcriptCb?.({ type: 'final', text: 'hello there' }) })
    await stop(hook)

    expect(onTranscriptUpdate).toHaveBeenLastCalledWith('hello there')
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a stream error with the session, and not again as a missing transcript', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    await startRecording(hook)
    adapter.heard(4, 9000)
    await act(async () => { adapter.errorCb?.(new Error('OpenAI connection closed: 1008 policy violation')) })

    expect(hook.result.current.error).toBe('OpenAI connection closed: 1008 policy violation')
    expect(reporting.captureRendererException).toHaveBeenCalledTimes(1)
    const [err, context] = reporting.captureRendererException.mock.calls[0]
    expect((err as Error).message).toContain('1008')
    expect(context.tags).toEqual({ feature: 'dictation', stage: 'stream', provider: 'openai' })
    expect(context.extra).toMatchObject({ bytesReceived: 24000 * 2 * 4, captureKind: 'worklet' })
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a socket that failed to connect under its own stage', async () => {
    const adapter = new FakeAdapter()
    adapter.connectResult = Promise.reject(new Error('OpenAI Realtime WebSocket connection timed out'))
    adapter.connectResult.catch(() => {})
    const { hook } = arrange(adapter)
    await start(hook)

    expect(hook.result.current.error).toContain('timed out')
    expect(reporting.captureRendererException.mock.calls[0][1].tags).toEqual({ feature: 'dictation', stage: 'connect', provider: 'openai' })
    expect(reporting.captureRendererMessage).not.toHaveBeenCalled()
  })

  it('reports a failure to obtain credentials before any session exists', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    api.apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'No API key configured for OpenAI. Add one in Settings > Voice.' }) })
    await start(hook)

    expect(hook.result.current.error).toContain('No API key configured')
    expect(reporting.captureRendererException.mock.calls[0][1].tags).toEqual({ feature: 'dictation', stage: 'credentials', provider: 'unknown' })
  })

  it('treats a refused microphone permission as a breadcrumb, not a defect', async () => {
    const adapter = new FakeAdapter()
    const { hook } = arrange(adapter)
    stt.acquireMicStream.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))
    await start(hook)

    expect(hook.result.current.error).toBeTruthy()
    expect(hook.result.current.isRecording).toBe(false)
    expect(reporting.captureRendererException).not.toHaveBeenCalled()
    expect(reporting.addRendererBreadcrumb).toHaveBeenCalledWith('dictation', 'microphone permission refused', { stage: 'capture' })
  })
})
