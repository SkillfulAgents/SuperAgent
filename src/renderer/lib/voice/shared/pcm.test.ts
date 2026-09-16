import { describe, it, expect } from 'vitest'
import { float32ToInt16, arrayBufferToBase64 } from './pcm'

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
