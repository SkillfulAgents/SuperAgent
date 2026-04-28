import { useEffect, useState } from 'react'
import { Vibrant } from 'node-vibrant/browser'
import type { Palette, Swatch } from '@vibrant/color'

export interface SerializedSwatch {
  hex: string
  rgb: [number, number, number]
  hsl: [number, number, number]
  population: number
  titleTextColor: string
  bodyTextColor: string
}

export type SerializedPalette = Record<string, SerializedSwatch | null>

export type PaletteStatus = 'loading' | 'ready' | 'error'

export interface PaletteResult {
  status: PaletteStatus
  palette: SerializedPalette | null
}

const READY_CACHE = new Map<string, SerializedPalette>()
const IN_FLIGHT = new Map<string, Promise<SerializedPalette | null>>()

function serializeSwatch(swatch: Swatch | null): SerializedSwatch | null {
  if (!swatch) return null
  return {
    hex: swatch.hex,
    rgb: swatch.rgb,
    hsl: swatch.hsl,
    population: swatch.population,
    titleTextColor: swatch.titleTextColor,
    bodyTextColor: swatch.bodyTextColor,
  }
}

function serializePalette(palette: Palette): SerializedPalette {
  const out: SerializedPalette = {}
  for (const [name, swatch] of Object.entries(palette)) {
    out[name] = serializeSwatch(swatch)
  }
  return out
}

// Fraction of the image height (from the top) to feed to the quantizer. The
// DashboardCard renders the image with `object-cover object-top` into a short
// card, so only the top slice is ever visible — sampling lower regions would
// analyse pixels the user never sees. We sample a band wide enough to stay
// meaningful across viewport widths but short enough to stay within what the
// card actually shows at typical sizes.
const TOP_SAMPLE_FRACTION = 0.25

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    // Same-origin through the API base URL, so anonymous CORS is fine and
    // lets us read pixels for canvas sampling.
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (err) => reject(err)
    img.src = url
  })
}

async function extract(url: string): Promise<SerializedPalette | null> {
  const img = await loadImage(url)
  const fullW = img.naturalWidth
  const fullH = img.naturalHeight
  if (fullW === 0 || fullH === 0) return null
  const cropHeight = Math.max(1, Math.round(fullH * TOP_SAMPLE_FRACTION))
  const canvas = document.createElement('canvas')
  canvas.width = fullW
  canvas.height = cropHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(
    img,
    0, 0, fullW, cropHeight,
    0, 0, fullW, cropHeight,
  )
  // Vibrant's public type accepts string | HTMLImageElement; pass the canvas
  // back via a data URL so we don't need to cast.
  const dataUrl = canvas.toDataURL('image/png')
  const palette = await Vibrant.from(dataUrl).getPalette()
  return serializePalette(palette)
}

/**
 * Extract a Vibrant palette from an image URL. Memoized per-URL across the
 * whole app — concurrent callers share a single in-flight promise. Failures
 * are remembered so we don't re-attempt on every re-render.
 *
 * Returns `status: 'loading'` while the extraction is in flight, `'ready'`
 * with the palette once done, or `'error'` if extraction failed. Callers
 * typically skip rendering tone-dependent UI while loading to avoid flashing
 * a default style before the real colors arrive.
 */
export function useImagePalette(url: string | null): PaletteResult {
  const [state, setState] = useState<PaletteResult>(() => {
    if (!url) return { status: 'ready', palette: null }
    if (READY_CACHE.has(url)) return { status: 'ready', palette: READY_CACHE.get(url)! }
    return { status: 'loading', palette: null }
  })

  useEffect(() => {
    if (!url) {
      setState({ status: 'ready', palette: null })
      return
    }
    const cached = READY_CACHE.get(url)
    if (cached) {
      setState({ status: 'ready', palette: cached })
      return
    }

    let cancelled = false
    setState({ status: 'loading', palette: null })

    // Failures are intentionally not cached — if a screenshot was missing on
    // first attempt but later lands on disk (e.g. capture finished after the
    // first render), the next render gets to re-try instead of being stuck.
    let promise = IN_FLIGHT.get(url)
    if (!promise) {
      promise = extract(url)
        .then((palette) => {
          if (palette) READY_CACHE.set(url, palette)
          return palette
        })
        .catch((err) => {
          console.warn('[useImagePalette] extraction failed', url, err)
          return null
        })
        .finally(() => {
          IN_FLIGHT.delete(url)
        })
      IN_FLIGHT.set(url, promise)
    }

    promise.then((palette) => {
      if (cancelled) return
      if (palette) setState({ status: 'ready', palette })
      else setState({ status: 'error', palette: null })
    })

    return () => {
      cancelled = true
    }
  }, [url])

  return state
}

/** Test-only helper — not exported from module index. */
export function __resetImagePaletteCache(): void {
  READY_CACHE.clear()
  IN_FLIGHT.clear()
}
