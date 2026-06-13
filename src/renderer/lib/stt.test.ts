import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSttAdapter, type TranscriptEvent } from './stt'
import { MockWebSocket } from '@shared/test/mock-websocket'

// float32ToInt16 and arrayBufferToBase64 are not exported, so we test them
// indirectly or replicate the logic. Since they're private, we test via the
// public API where possible and replicate for direct validation.

// ============================================================================
// float32ToInt16 (replicated for direct testing since it's not exported)
// ============================================================================

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return int16
}

describe('float32ToInt16', () => {
  it('converts silence (0.0) to 0', () => {
    const input = new Float32Array([0.0])
    const output = float32ToInt16(input)
    expect(output[0]).toBe(0)
  })

  it('converts max positive (1.0) to 32767 (0x7FFF)', () => {
    const input = new Float32Array([1.0])
    const output = float32ToInt16(input)
    expect(output[0]).toBe(32767)
  })

  it('converts max negative (-1.0) to -32768 (0x8000)', () => {
    const input = new Float32Array([-1.0])
    const output = float32ToInt16(input)
    expect(output[0]).toBe(-32768)
  })

  it('clamps values above 1.0', () => {
    const input = new Float32Array([1.5])
    const output = float32ToInt16(input)
    expect(output[0]).toBe(32767) // clamped to 1.0 then converted
  })

  it('clamps values below -1.0', () => {
    const input = new Float32Array([-1.5])
    const output = float32ToInt16(input)
    expect(output[0]).toBe(-32768) // clamped to -1.0 then converted
  })

  it('converts 0.5 to approximately half of max positive', () => {
    const input = new Float32Array([0.5])
    const output = float32ToInt16(input)
    // 0.5 * 0x7FFF = 16383.5, truncated to 16383
    expect(output[0]).toBe(16383)
  })

  it('converts -0.5 to approximately half of max negative', () => {
    const input = new Float32Array([-0.5])
    const output = float32ToInt16(input)
    // -0.5 * 0x8000 = -16384
    expect(output[0]).toBe(-16384)
  })

  it('handles empty array', () => {
    const input = new Float32Array([])
    const output = float32ToInt16(input)
    expect(output.length).toBe(0)
  })

  it('converts multiple samples', () => {
    const input = new Float32Array([0.0, 1.0, -1.0, 0.5, -0.5])
    const output = float32ToInt16(input)
    expect(output.length).toBe(5)
    expect(output[0]).toBe(0)
    expect(output[1]).toBe(32767)
    expect(output[2]).toBe(-32768)
    expect(output[3]).toBe(16383)
    expect(output[4]).toBe(-16384)
  })

  it('preserves sign for small values near zero', () => {
    const input = new Float32Array([0.001, -0.001])
    const output = float32ToInt16(input)
    expect(output[0]).toBeGreaterThan(0)
    expect(output[1]).toBeLessThan(0)
  })
})

// ============================================================================
// arrayBufferToBase64 (replicated for direct testing since it's not exported)
// ============================================================================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

describe('arrayBufferToBase64', () => {
  it('converts empty buffer to empty string', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('')
  })

  it('converts single byte', () => {
    const buf = new Uint8Array([0xff]).buffer
    expect(arrayBufferToBase64(buf)).toBe(btoa('\xff'))
  })

  it('converts known byte sequence', () => {
    // "Hello" in bytes
    const buf = new Uint8Array([72, 101, 108, 108, 111]).buffer
    expect(arrayBufferToBase64(buf)).toBe(btoa('Hello'))
  })

  it('handles binary data with null bytes', () => {
    const buf = new Uint8Array([0, 1, 2, 3]).buffer
    const result = arrayBufferToBase64(buf)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })

  it('produces valid base64', () => {
    const buf = new Uint8Array([10, 20, 30, 40, 50]).buffer
    const result = arrayBufferToBase64(buf)
    // Valid base64 characters only
    expect(result).toMatch(/^[A-Za-z0-9+/]+=*$/)
  })
})

// ============================================================================
// createSttAdapter (factory)
// ============================================================================

describe('createSttAdapter', () => {
  it('creates a deepgram adapter', () => {
    const adapter = createSttAdapter('deepgram')
    expect(adapter).toBeDefined()
    expect(typeof adapter.connect).toBe('function')
    expect(typeof adapter.sendAudio).toBe('function')
    expect(typeof adapter.onTranscript).toBe('function')
    expect(typeof adapter.onError).toBe('function')
    expect(typeof adapter.close).toBe('function')
  })

  it('creates an openai adapter', () => {
    const adapter = createSttAdapter('openai')
    expect(adapter).toBeDefined()
    expect(adapter.sampleRate).toBe(24000)
  })

  it('deepgram adapter has default sample rate (undefined = 16000)', () => {
    const adapter = createSttAdapter('deepgram')
    // DeepgramAdapter doesn't set sampleRate, defaults to 16000 in startAudioCapture
    expect(adapter.sampleRate).toBeUndefined()
  })

  it('throws for unknown provider', () => {
    expect(() => createSttAdapter('unknown' as any)).toThrow('Unknown STT provider: unknown')
  })
})

// ============================================================================
// Pre-connection audio buffering
// ============================================================================

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
