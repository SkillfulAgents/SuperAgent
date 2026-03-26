import { describe, it, expect } from 'vitest'
import { createSttAdapter } from './stt'

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
