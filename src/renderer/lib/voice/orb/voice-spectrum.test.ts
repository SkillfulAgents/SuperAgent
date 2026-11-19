import { describe, expect, it } from 'vitest'
import { BAND_COUNT, VoiceSpectrumMeter, spectrumShape } from './voice-spectrum'

/** Per-bin decibels for one tone over a quiet floor, as an analyser reports them. */
function tone(bins: number, binHz: number, hz: number, floor = -110, peak = -20): Float32Array {
  const decibels = new Float32Array(bins).fill(floor)
  decibels[Math.round(hz / binHz)] = peak
  return decibels
}

function analyserOf(decibels: Float32Array, rms: number): AnalyserNode {
  const fftSize = decibels.length * 2
  return {
    fftSize,
    frequencyBinCount: decibels.length,
    context: { sampleRate: 48000 },
    getByteTimeDomainData: (out: Uint8Array) => out.fill(128 + Math.round(rms * 128)),
    getFloatFrequencyData: (out: Float32Array) => out.set(decibels),
  } as unknown as AnalyserNode
}

describe('spectrumShape', () => {
  it('stands the band holding a tone tallest and drops bands far from it', () => {
    const binHz = 48000 / 2048
    const shape = spectrumShape(tone(1024, binHz, 1000), binHz)
    expect(shape).toHaveLength(BAND_COUNT)
    const loudest = shape.indexOf(Math.max(...shape))
    expect(shape[loudest]).toBe(1)
    // 150 Hz × 40^(b/16) brackets 1 kHz in band 8.
    expect(loudest).toBe(8)
    expect(shape[0]).toBe(0)
    expect(shape[BAND_COUNT - 1]).toBe(0)
  })

  it('still reads a coarse analyser, whose low bands are narrower than a bin', () => {
    const binHz = 48000 / 256
    const shape = spectrumShape(tone(128, binHz, 3000), binHz)
    expect(shape.every(v => v >= 0 && v <= 1)).toBe(true)
    expect(shape.indexOf(1)).toBeGreaterThan(BAND_COUNT / 2)
  })
})

describe('VoiceSpectrumMeter', () => {
  it('has a level alone without an analyser, and bands scaled by the level with one', () => {
    const meter = new VoiceSpectrumMeter()
    meter.advance(null, 1, 1)
    expect(meter.bands).toBeNull()
    expect(meter.level).toBeGreaterThan(0.99)

    const analyser = analyserOf(tone(1024, 48000 / 2048, 1000), 0.2)
    for (let i = 0; i < 60; i++) meter.advance(analyser, 0, 1 / 60)
    const bands = meter.bands!
    expect(Math.max(...bands)).toBeCloseTo(meter.level, 3)
    expect(bands[0]).toBeLessThan(0.01)
  })

  it('falls back to rest when the voice goes quiet', () => {
    const meter = new VoiceSpectrumMeter()
    const loud = analyserOf(tone(1024, 48000 / 2048, 1000), 0.2)
    for (let i = 0; i < 30; i++) meter.advance(loud, 0, 1 / 60)
    const quiet = analyserOf(tone(1024, 48000 / 2048, 1000), 0)
    for (let i = 0; i < 120; i++) meter.advance(quiet, 0, 1 / 60)
    expect(Math.max(...meter.bands!)).toBeLessThan(0.01)
  })
})
