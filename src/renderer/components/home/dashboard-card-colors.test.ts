import { describe, it, expect } from 'vitest'
import {
  pickDashboardSwatch,
  buildGradient,
  deriveForegroundColor,
  hexToRgb,
  hslToRgb,
} from './dashboard-card-colors'
import type { SerializedSwatch } from '@renderer/hooks/use-image-palette'

function swatch(
  overrides: Partial<SerializedSwatch> & Pick<SerializedSwatch, 'hex' | 'population'>
): SerializedSwatch {
  return {
    hex: overrides.hex,
    rgb: overrides.rgb ?? [0, 0, 0],
    hsl: overrides.hsl ?? [0, 0, 0],
    population: overrides.population,
    titleTextColor: overrides.titleTextColor ?? '#ffffff',
    bodyTextColor: overrides.bodyTextColor ?? '#ffffff',
  }
}

describe('hexToRgb', () => {
  it('parses a full 6-digit hex', () => {
    expect(hexToRgb('#ff8800')).toEqual([255, 136, 0])
  })

  it('accepts hex without leading hash', () => {
    expect(hexToRgb('ff8800')).toEqual([255, 136, 0])
  })

  it('is case-insensitive', () => {
    expect(hexToRgb('#FF8800')).toEqual([255, 136, 0])
  })

  it('returns null for short/invalid hex', () => {
    expect(hexToRgb('#fff')).toBeNull()
    expect(hexToRgb('not-a-colour')).toBeNull()
    expect(hexToRgb('')).toBeNull()
  })
})

describe('hslToRgb', () => {
  it('returns grayscale when saturation is 0', () => {
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0])
    expect(hslToRgb(0, 0, 1)).toEqual([255, 255, 255])
    expect(hslToRgb(0.5, 0, 0.5)).toEqual([128, 128, 128])
  })

  it('converts pure red correctly', () => {
    const [r, g, b] = hslToRgb(0, 1, 0.5)
    expect(r).toBe(255)
    expect(g).toBe(0)
    expect(b).toBe(0)
  })

  it('converts pure green correctly', () => {
    const [r, g, b] = hslToRgb(1 / 3, 1, 0.5)
    expect(r).toBe(0)
    expect(g).toBe(255)
    expect(b).toBe(0)
  })

  it('converts pure blue correctly', () => {
    const [r, g, b] = hslToRgb(2 / 3, 1, 0.5)
    expect(r).toBe(0)
    expect(g).toBe(0)
    expect(b).toBe(255)
  })
})

describe('pickDashboardSwatch', () => {
  it('returns null for an empty palette', () => {
    expect(pickDashboardSwatch({})).toBeNull()
    expect(pickDashboardSwatch({ Muted: null, Vibrant: null })).toBeNull()
  })

  it('picks the highest-population swatch', () => {
    const hi = swatch({ hex: '#aabbcc', population: 1000 })
    const lo = swatch({ hex: '#112233', population: 10 })
    const pick = pickDashboardSwatch({ Muted: lo, Vibrant: hi })
    expect(pick?.hex).toBe('#aabbcc')
  })

  it('prefers Muted variants when populations tie', () => {
    const muted = swatch({ hex: '#aaaaaa', population: 500 })
    const vibrant = swatch({ hex: '#ff0000', population: 500 })
    const pick = pickDashboardSwatch({ Vibrant: vibrant, Muted: muted })
    expect(pick?.hex).toBe('#aaaaaa')
  })

  it('ignores null swatches', () => {
    const only = swatch({ hex: '#123456', population: 42 })
    const pick = pickDashboardSwatch({ Muted: null, Vibrant: only })
    expect(pick?.hex).toBe('#123456')
  })
})

describe('deriveForegroundColor', () => {
  it('returns a dark-tinted colour for a light swatch', () => {
    // Near-white swatch, hue=0 (red). Should produce dark with low L.
    const s = swatch({ hex: '#f5e8e8', hsl: [0, 0.3, 0.93], population: 100 })
    const fg = deriveForegroundColor(s)
    // L should be 0.08, so r/g/b all small (<= ~50). Parse rgb(r, g, b).
    const match = fg.match(/rgb\((\d+), (\d+), (\d+)\)/)
    expect(match).not.toBeNull()
    if (match) {
      const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
      expect(Math.max(r, g, b)).toBeLessThan(50)
    }
  })

  it('returns a light-tinted colour for a dark swatch', () => {
    const s = swatch({ hex: '#1a1a2a', hsl: [0.6, 0.3, 0.15], population: 100 })
    const fg = deriveForegroundColor(s)
    const match = fg.match(/rgb\((\d+), (\d+), (\d+)\)/)
    expect(match).not.toBeNull()
    if (match) {
      const [r, g, b] = [Number(match[1]), Number(match[2]), Number(match[3])]
      expect(Math.min(r, g, b)).toBeGreaterThan(200)
    }
  })
})

describe('buildGradient', () => {
  it('produces a themed fallback when no swatch is provided', () => {
    const g = buildGradient(null)
    expect(g).toContain('hsl(var(--background))')
    expect(g).toContain('transparent 70%')
  })

  it('anchors to the swatch rgb when provided', () => {
    const s = swatch({ hex: '#112233', population: 1 })
    const g = buildGradient(s)
    expect(g).toContain('rgb(17, 34, 51) 0%')
    expect(g).toContain('rgba(17, 34, 51, 0.6) 30%')
    expect(g).toContain('rgba(17, 34, 51, 0) 70%')
  })

  it('falls back to themed gradient when swatch has malformed hex', () => {
    const s = swatch({ hex: 'not-hex', population: 1 })
    const g = buildGradient(s)
    expect(g).toContain('hsl(var(--background))')
  })
})
