import type { SerializedSwatch } from '@renderer/hooks/use-image-palette'

/**
 * Pick the swatch that best represents the dashboard for the DashboardCard
 * overlay. Uses raw population: the swatch covering the most pixels in the
 * image wins, so a mostly-white dashboard yields a white/light overlay rather
 * than latching onto a low-population dark accent (e.g. text or a button).
 * Ties broken in favour of Muted swatches over Vibrant for a calmer gradient.
 */
export function pickDashboardSwatch(
  palette: Record<string, SerializedSwatch | null>
): SerializedSwatch | null {
  const mutedPreference = new Set(['Muted', 'DarkMuted', 'LightMuted'])
  const entries = Object.entries(palette).filter(
    (entry): entry is [string, SerializedSwatch] => entry[1] !== null
  )
  if (entries.length === 0) return null
  entries.sort(([nameA, a], [nameB, b]) => {
    if (b.population !== a.population) return b.population - a.population
    const mutedA = mutedPreference.has(nameA) ? 1 : 0
    const mutedB = mutedPreference.has(nameB) ? 1 : 0
    return mutedB - mutedA
  })
  return entries[0][1]
}

/**
 * Build the card's gradient CSS value from the chosen swatch. Falls back to a
 * theme-driven gradient when no swatch is available.
 */
export function buildGradient(swatch: SerializedSwatch | null): string {
  const base = swatch ? hexToRgb(swatch.hex) : null
  if (!base) {
    return 'linear-gradient(to top, hsl(var(--background)) 0%, hsl(var(--background) / 0.6) 30%, transparent 70%)'
  }
  const [r, g, b] = base
  return `linear-gradient(to top, rgb(${r}, ${g}, ${b}) 0%, rgba(${r}, ${g}, ${b}, 0.6) 30%, rgba(${r}, ${g}, ${b}, 0) 70%)`
}

/**
 * Derive a foreground text colour from the chosen swatch. Keeps the swatch's
 * hue for a "matchy fun" tint but jumps to the opposite end of the lightness
 * spectrum for contrast. node-vibrant's built-in titleTextColor is binary
 * black/white with an aggressive YIQ threshold that often renders white-on-
 * light-grey, so we do our own mapping.
 */
export function deriveForegroundColor(swatch: SerializedSwatch): string {
  const [h, s, l] = swatch.hsl
  const targetL = l < 0.5 ? 0.95 : 0.08
  const targetS = Math.min(0.5, s * 0.8 + 0.05)
  const [r, g, b] = hslToRgb(h, targetS, targetL)
  return `rgb(${r}, ${g}, ${b})`
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i)
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ]
}
