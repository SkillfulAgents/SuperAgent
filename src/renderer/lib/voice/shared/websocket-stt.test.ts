import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSttAdapter } from '../registry/stt'
import type { TranscriptEvent } from '../contracts/stt'
import { MockWebSocket } from '@shared/test/mock-websocket'

// The WebSocket STT lifecycle is shared by both vendor adapters; each case runs
// against the real adapter so vendor framing is exercised too.
// Local alias so the existing test bodies (FakeWebSocket.OPEN, .instances, etc.)
// keep reading naturally against the shared mock.
const FakeWebSocket = MockWebSocket

function chunkOf(byteLength: number, fillByte: number): ArrayBuffer {
  return new Uint8Array(byteLength).fill(fillByte).buffer
}

describe('pre-connection audio buffering', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.autoOpen = false // these tests drive open via simulateOpen()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // Keep the adapters' connect timeout from outliving the suite
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('deepgram: buffers audio sent before open and flushes it on open, in order', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    const a = chunkOf(4, 1)
    const b = chunkOf(4, 2)
    adapter.sendAudio(a)
    adapter.sendAudio(b)
    expect(ws.sent).toHaveLength(0)

    ws.simulateOpen()
    await connectPromise

    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[0]).toBe(a)
    expect(ws.sent[1]).toBe(b)

    // Live audio after open goes straight through
    const c = chunkOf(4, 3)
    adapter.sendAudio(c)
    expect(ws.sent).toHaveLength(3)
    expect(ws.sent[2]).toBe(c)
  })

  it('deepgram: drops oldest chunks when the pre-open buffer overflows', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    // 3 chunks of 400KB against a 1MB cap — the first should be dropped
    const big1 = chunkOf(400_000, 1)
    const big2 = chunkOf(400_000, 2)
    const big3 = chunkOf(400_000, 3)
    adapter.sendAudio(big1)
    adapter.sendAudio(big2)
    adapter.sendAudio(big3)

    ws.simulateOpen()
    await connectPromise

    expect(ws.sent).toHaveLength(2)
    expect(ws.sent[0]).toBe(big2)
    expect(ws.sent[1]).toBe(big3)
  })

  it('deepgram: discards buffered audio and stops buffering after close', () => {
    const adapter = createSttAdapter('deepgram')
    adapter.connect('token').catch(() => {})
    adapter.sendAudio(chunkOf(4, 1))
    adapter.close()
    adapter.sendAudio(chunkOf(4, 2))

    const ws = FakeWebSocket.instances[0]
    expect(ws.sent).toHaveLength(0)
  })

  it('deepgram: deliberate close during connect does not surface an error', () => {
    const adapter = createSttAdapter('deepgram')
    const errors: Error[] = []
    adapter.onError((err) => errors.push(err))
    adapter.connect('token').catch(() => {})
    const ws = FakeWebSocket.instances[0]

    adapter.close()
    // Closing a CONNECTING socket fires a non-clean close event
    ws.simulateClose(1006)

    expect(errors).toHaveLength(0)
  })

  it('openai: flushes buffered audio as append messages after the session config', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    adapter.sendAudio(new Uint8Array([1, 2, 3]).buffer)
    adapter.sendAudio(new Uint8Array([4, 5, 6]).buffer)
    expect(ws.sent).toHaveLength(0)

    ws.simulateOpen()
    await connectPromise

    const messages = ws.sent.map((m) => JSON.parse(m as string))
    expect(messages).toHaveLength(3)
    expect(messages[0].type).toBe('session.update')
    expect(messages[1]).toEqual({ type: 'input_audio_buffer.append', audio: btoa('\x01\x02\x03') })
    expect(messages[2]).toEqual({ type: 'input_audio_buffer.append', audio: btoa('\x04\x05\x06') })
  })

  it('openai: deliberate close during connect does not surface an error', () => {
    const adapter = createSttAdapter('openai')
    const errors: Error[] = []
    adapter.onError((err) => errors.push(err))
    adapter.connect('token').catch(() => {})
    const ws = FakeWebSocket.instances[0]

    adapter.close()
    ws.simulateClose(1006)

    expect(errors).toHaveLength(0)
  })
})

// ============================================================================
// Graceful finish (flush buffered audio + await trailing transcripts)
// ============================================================================

const FLUSH_TIMEOUT_MS = 1_500

function jsonSent(ws: { sent: (string | ArrayBuffer)[] }): any[] {
  return ws.sent.filter((m): m is string => typeof m === 'string').map((m) => JSON.parse(m))
}

describe('graceful finish', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.autoOpen = false // these tests drive open via simulateOpen()
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('deepgram: finish during the handshake flushes buffered audio, THEN sends CloseStream', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    const a = chunkOf(4, 1)
    const b = chunkOf(4, 2)
    adapter.sendAudio(a)
    adapter.sendAudio(b)

    const finishPromise = adapter.finish()
    expect(ws.sent).toHaveLength(0) // nothing sent until the socket opens

    ws.simulateOpen()
    await connectPromise

    // Buffered audio flushed first, then the finalize message
    expect(ws.sent.slice(0, 2)).toEqual([a, b])
    expect(JSON.parse(ws.sent[2] as string)).toEqual({ type: 'CloseStream' })

    // Server flushes trailing finals then closes — that resolves finish()
    ws.simulateClose(1000)
    await finishPromise
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('deepgram: trailing finals after CloseStream reach the transcript callback before finish resolves', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    const events: TranscriptEvent[] = []
    adapter.onTranscript((e) => events.push(e))

    adapter.sendAudio(chunkOf(4, 1)) // live, goes straight through
    const finishPromise = adapter.finish()
    expect(JSON.parse(ws.sent.at(-1) as string)).toEqual({ type: 'CloseStream' })

    ws.simulateMessage({ type: 'Results', speech_final: true, channel: { alternatives: [{ transcript: 'ship it' }] } })
    ws.simulateClose(1000)
    await finishPromise

    expect(events).toEqual([{ type: 'final', text: 'ship it' }])
  })

  it('deepgram: finish resolves via the backstop timeout if the server never closes', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    const finishPromise = adapter.finish()
    let resolved = false
    finishPromise.then(() => { resolved = true })

    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS)
    await finishPromise
    expect(resolved).toBe(true)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('deepgram: finish with no live socket resolves immediately', async () => {
    const adapter = createSttAdapter('deepgram')
    await adapter.finish() // never connected — must not hang
  })

  it('deepgram: a deliberate close() while finish() is pending resolves the finish promise', async () => {
    const adapter = createSttAdapter('deepgram')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    const finishPromise = adapter.finish() // pending, awaiting trailing finals
    adapter.close()
    await finishPromise // would hang if close() didn't unblock it
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('deepgram: finish does not surface a spurious error if the socket errors mid-flush', async () => {
    const adapter = createSttAdapter('deepgram')
    const errors: Error[] = []
    adapter.onError((e) => errors.push(e))
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    const finishPromise = adapter.finish()
    ws.onerror?.() // connection drops while we await finals
    ws.simulateClose(1006)
    await finishPromise

    expect(errors).toHaveLength(0)
  })

  it('openai: finish during the handshake flushes appends, THEN commits, and resolves on completed', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    adapter.sendAudio(new Uint8Array([1, 2, 3]).buffer)
    const finishPromise = adapter.finish()
    expect(ws.sent).toHaveLength(0)

    ws.simulateOpen()
    await connectPromise

    const messages = jsonSent(ws)
    expect(messages[0].type).toBe('session.update')
    expect(messages[1]).toEqual({ type: 'input_audio_buffer.append', audio: btoa('\x01\x02\x03') })
    expect(messages[2]).toEqual({ type: 'input_audio_buffer.commit' })

    const events: TranscriptEvent[] = []
    adapter.onTranscript((e) => events.push(e))
    ws.simulateMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'ship it' })
    await finishPromise

    expect(events).toEqual([{ type: 'final', text: 'ship it' }])
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('openai: finish resolves via the backstop timeout if no completion arrives', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    adapter.sendAudio(new Uint8Array([1, 2, 3]).buffer) // uncommitted audio → commit + wait
    const finishPromise = adapter.finish()
    let resolved = false
    finishPromise.then(() => { resolved = true })

    expect(resolved).toBe(false)
    await vi.advanceTimersByTimeAsync(FLUSH_TIMEOUT_MS)
    await finishPromise
    expect(resolved).toBe(true)
  })

  it('openai: finish with no uncommitted audio does NOT commit and completes immediately', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise
    const sentBefore = ws.sent.length

    // Nothing spoken since the last commit — finish must not send a commit
    // (committing an empty buffer triggers OpenAI's "buffer too small" error).
    await adapter.finish()

    expect(jsonSent(ws).some((m) => m.type === 'input_audio_buffer.commit')).toBe(false)
    expect(ws.sent.length).toBe(sentBefore)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('openai: a server auto-commit clears pending audio so a later finish skips the commit', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    // Speak, then the server auto-commits + transcribes the utterance (server_vad)
    adapter.sendAudio(new Uint8Array([1, 2, 3]).buffer)
    ws.simulateMessage({ type: 'input_audio_buffer.committed' })
    const sentBefore = ws.sent.length

    // Stop after the transcribe — nothing left uncommitted
    await adapter.finish()

    expect(ws.sent.length).toBe(sentBefore) // no commit sent
  })

  it('openai: a benign error while finishing is suppressed, not surfaced', async () => {
    const adapter = createSttAdapter('openai')
    const errors: Error[] = []
    adapter.onError((e) => errors.push(e))
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    adapter.sendAudio(new Uint8Array([1, 2, 3]).buffer)
    const finishPromise = adapter.finish() // sends commit, awaits completion
    // Server rejects the commit (e.g. raced its own auto-commit)
    ws.simulateMessage({ type: 'error', error: { message: 'buffer too small' } })
    await finishPromise

    expect(errors).toHaveLength(0)
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('openai: a real error during normal streaming is still surfaced', async () => {
    const adapter = createSttAdapter('openai')
    const errors: Error[] = []
    adapter.onError((e) => errors.push(e))
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise

    ws.simulateMessage({ type: 'error', error: { message: 'something broke' } })

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toBe('something broke')
  })
})

// ============================================================================
// Mid-stream finalize (voice mode takes an utterance without closing)
// ============================================================================

describe('finalize', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.autoOpen = false
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('deepgram: sends Finalize on an open socket and reports the finals it produces, then finalized', async () => {
    const adapter = createSttAdapter('deepgram')
    adapter.finalize() // no socket yet: nothing to do
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    adapter.finalize() // still connecting: nothing to do
    ws.simulateOpen()
    await connectPromise
    expect(ws.sent).toHaveLength(0)

    const events: TranscriptEvent[] = []
    adapter.onTranscript((e) => events.push(e))
    adapter.finalize()
    expect(jsonSent(ws)).toEqual([{ type: 'Finalize' }])

    ws.simulateMessage({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: 'the tail' }] } })
    expect(events).toEqual([{ type: 'final', text: 'the tail' }, { type: 'finalized', text: '' }])

    // Nothing pending: an empty finalize result still answers.
    adapter.finalize()
    ws.simulateMessage({ type: 'Results', is_final: true, from_finalize: true, channel: { alternatives: [{ transcript: '' }] } })
    expect(events).toHaveLength(3)
    expect(events[2]).toEqual({ type: 'finalized', text: '' })
    // The socket stays open for the next utterance.
    expect(ws.readyState).toBe(FakeWebSocket.OPEN)
  })

  it('openai: commits the pending audio and reports finalized on its transcript', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise
    const events: TranscriptEvent[] = []
    adapter.onTranscript((e) => events.push(e))

    adapter.sendAudio(chunkOf(4, 1))
    adapter.finalize()
    expect(jsonSent(ws).at(-1)).toEqual({ type: 'input_audio_buffer.commit' })
    ws.simulateMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'ship it' })
    expect(events).toEqual([{ type: 'final', text: 'ship it' }, { type: 'finalized', text: '' }])

    // A server-driven completion later is a plain final, not an answer to a finalize.
    ws.simulateMessage({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'more' })
    expect(events.at(-1)).toEqual({ type: 'final', text: 'more' })
  })

  it('openai: with nothing to commit, finalize answers at once without a commit', async () => {
    const adapter = createSttAdapter('openai')
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise
    const events: TranscriptEvent[] = []
    adapter.onTranscript((e) => events.push(e))
    const before = ws.sent.length

    adapter.finalize()
    expect(ws.sent).toHaveLength(before)
    expect(events).toEqual([{ type: 'finalized', text: '' }])
  })
})

// ============================================================================
// Session stats (what an error report can say about a session after the fact)
// ============================================================================

describe('session stats', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    FakeWebSocket.autoOpen = false
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function pcm(...samples: number[]): ArrayBuffer {
    return Int16Array.from(samples).buffer as ArrayBuffer
  }

  it('deepgram: records the socket opening, the audio that flowed and its peak, the words, and how it closed', async () => {
    const adapter = createSttAdapter('deepgram')
    const errors: Error[] = []
    adapter.onError((err) => errors.push(err))
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]

    adapter.sendAudio(pcm(0, 1200, -3000))
    expect(adapter.stats).toMatchObject({ socketOpened: false, bytesReceived: 6, bytesSent: 0, peakSample: 3000 })

    ws.simulateOpen()
    await connectPromise
    expect(adapter.stats).toMatchObject({ socketOpened: true, bytesSent: 6 })
    expect(typeof adapter.stats!.connectMs).toBe('number')

    ws.simulateMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hi' }] } })
    ws.simulateMessage({ type: 'Results', is_final: false, channel: { alternatives: [{ transcript: 'hi there' }] } })
    expect(adapter.stats).toMatchObject({ finals: 1, interims: 1, serverEvents: { Results: 2 } })

    ws.simulateClose(1011, 'server went away')
    expect(errors).toHaveLength(1)
    expect(adapter.stats).toMatchObject({ closeCode: 1011, closeReason: 'server went away', errors: 1 })
    expect(adapter.stats!.lastError).toContain('1011')
  })

  it('counts audio discarded from an overflowing pre-open buffer', () => {
    const adapter = createSttAdapter('deepgram')
    void adapter.connect('token').catch(() => {})
    adapter.sendAudio(chunkOf(600_000, 1))
    adapter.sendAudio(chunkOf(600_000, 2))
    expect(adapter.stats).toMatchObject({ bytesReceived: 1_200_000, bytesDropped: 600_000, bytesSent: 0 })
  })

  it('openai: a failed transcription surfaces as an error instead of vanishing', async () => {
    const adapter = createSttAdapter('openai')
    const errors: Error[] = []
    adapter.onError((err) => errors.push(err))
    const connectPromise = adapter.connect('token')
    FakeWebSocket.instances[0].simulateOpen()
    await connectPromise

    FakeWebSocket.instances[0].simulateMessage({
      type: 'conversation.item.input_audio_transcription.failed',
      error: { message: 'The model `gpt-4o-mini-transcribe` is not available for this project' },
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain('not available for this project')
    expect(adapter.stats).toMatchObject({
      errors: 1,
      serverEvents: { 'conversation.item.input_audio_transcription.failed': 1 },
    })
  })

  it('openai: an error swallowed while finishing still goes on the record', async () => {
    const adapter = createSttAdapter('openai')
    const errors: Error[] = []
    adapter.onError((err) => errors.push(err))
    const connectPromise = adapter.connect('token')
    const ws = FakeWebSocket.instances[0]
    ws.simulateOpen()
    await connectPromise
    adapter.sendAudio(pcm(1, 2, 3))

    const finishPromise = adapter.finish()
    ws.simulateMessage({ type: 'error', error: { message: 'insufficient_quota' } })
    await finishPromise
    expect(errors).toHaveLength(0)
    expect(adapter.stats!.lastError).toContain('quota')
  })
})
