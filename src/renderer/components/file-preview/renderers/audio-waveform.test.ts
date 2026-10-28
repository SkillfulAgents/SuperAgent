import { describe, expect, it } from 'vitest'
import { createFallbackWaveform, createWaveformPeaks } from './audio-waveform'

describe('createWaveformPeaks', () => {
  it('reduces samples to the requested number of normalized bars', () => {
    const peaks = createWaveformPeaks([
      new Float32Array([0, 0, 0.25, -0.25, 0.5, -0.5, 1, -1]),
    ], 4)

    expect(peaks).toHaveLength(4)
    expect(peaks[3]).toBe(1)
    expect(peaks[0]).toBeLessThan(peaks[1])
    expect(peaks[1]).toBeLessThan(peaks[2])
    expect(peaks.every(peak => peak >= 0.12 && peak <= 1)).toBe(true)
  })

  it('includes all decoded channels', () => {
    const peaks = createWaveformPeaks([
      new Float32Array([0, 0, 0, 0]),
      new Float32Array([0, 0, 1, 1]),
    ], 2)

    expect(peaks[1]).toBe(1)
    expect(peaks[0]).toBe(0.12)
  })

  it('returns quiet bars for empty audio', () => {
    expect(createWaveformPeaks([], 3)).toEqual([0.12, 0.12, 0.12])
    expect(createWaveformPeaks([], 0)).toEqual([])
  })
})

describe('createFallbackWaveform', () => {
  it('is deterministic and normalized', () => {
    const first = createFallbackWaveform(24)
    const second = createFallbackWaveform(24)

    expect(first).toEqual(second)
    expect(first).toHaveLength(24)
    expect(first.every(peak => peak >= 0.12 && peak <= 1)).toBe(true)
    expect(new Set(first).size).toBeGreaterThan(1)
  })
})
