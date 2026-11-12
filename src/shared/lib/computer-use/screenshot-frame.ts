/**
 * Lining a screenshot up with the screen, so the agent is told which screen
 * points the image it was shown covers.
 *
 * agent-desktop acts at screen points. Between those and the image's pixels
 * sit three changes, all made here:
 * - A window capture includes the window's drop shadow, a transparent margin
 *   that is wider when the window is focused. It is cropped off, so the image
 *   is the window and nothing else.
 * - A Retina capture has two pixels (or more) per point.
 * - The image is shrunk to what the model takes (see `fitImageSize`).
 *
 * A Windows capture has no shadow, but is smaller than its window's bounds
 * instead: they take in invisible resize borders it does not show
 * (`locateWindowsFrame`).
 *
 * The result says which screen area the image covers, so a pixel position
 * turns into a point with one multiplication.
 */

import { PNG } from 'pngjs'

/** An area of the screen in points, as agent-desktop reports window and display bounds. */
export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

/** A window a capture may show. */
export interface WindowCandidate {
  id: string
  app?: string
  bounds: ScreenArea
  /** The window has focus: of two windows a capture fits, the one it shows. */
  focused?: boolean
}

/** What a screenshot was taken of, as far as the host knows. */
export type ScreenshotTarget =
  | { kind: 'screen'; bounds: ScreenArea; label: string }
  | { kind: 'window'; candidates: WindowCandidate[] }

/** The screen area an image covers, and the window it shows, when it shows one. */
export interface ScreenshotFrame {
  area: ScreenArea
  window?: { id: string; app?: string }
  /** What the image shows, for the agent: "window w-12 (Safari)", "display 0". */
  label: string
}

export interface PreparedScreenshot {
  png: Buffer
  /** The image's size in pixels, as the agent sees it. */
  width: number
  height: number
  frame: ScreenshotFrame | null
  /** Why the image could not be lined up with the screen, when it could not. */
  unalignedReason?: string
}

/** The longest edge and the pixel count the model takes without shrinking an image itself. */
export const MAX_IMAGE_EDGE = 1568
export const MAX_IMAGE_PIXELS = 1_200_000

/** The size an image is shown at: shrunk, keeping its shape, to fit both limits. */
export function fitImageSize(width: number, height: number): { width: number; height: number } {
  let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height))
  if (width * scale * height * scale > MAX_IMAGE_PIXELS) scale = Math.sqrt(MAX_IMAGE_PIXELS / (width * height))
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  }
}

/** A rectangle of image pixels. */
export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}

/** Pixels at four bytes each, alpha last (RGBA or BGRA: only alpha is read here). */
interface Rgba {
  width: number
  height: number
  data: Uint8Array
}

/** A decoded capture, and a way to cut a region out of it and shrink that to a PNG. */
export interface DecodedCapture extends Rgba {
  shrink(region: PixelRect, width: number, height: number): Buffer
}

/** Decodes a PNG capture, or returns null when it cannot. */
export type CaptureDecoder = (png: Buffer) => DecodedCapture | null

let nativeDecoder: CaptureDecoder | null = null

/**
 * Called once by the process that has a native image decoder (Electron's
 * main process, see src/main/computer-use-screenshots.ts). A Retina window
 * capture is over ten million pixels, which pure JavaScript takes about a
 * third of a second to decode and shrink; without a native decoder, or when
 * it cannot read a capture, that is the way.
 */
export function setCaptureDecoder(next: CaptureDecoder | null): void {
  nativeDecoder = next
}

function decodeInJavaScript(png: Buffer): DecodedCapture {
  const image = PNG.sync.read(png)
  return {
    width: image.width,
    height: image.height,
    data: image.data,
    shrink: (region, width, height) => encode(resample(image, region, width, height), width, height),
  }
}

/** A pixel counts as part of the window when it is (nearly) opaque; the shadow never is. */
const OPAQUE = 250

/**
 * How far apart the horizontal and vertical pixels-per-point may be and still
 * be one scale. Tight: a popover poking 14 px past a 1,600-point window is
 * only a 1% difference, and must not pass for the window's edge.
 */
const SCALE_TOLERANCE = 0.005

function opaqueBounds(image: Rgba): PixelRect | null {
  const { width, height, data } = image
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] < OPAQUE) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

function sameScale(a: number, b: number): boolean {
  return Math.abs(a - b) <= SCALE_TOLERANCE * Math.max(a, b)
}

/**
 * Where a window sits in its own capture, in pixels, or null when the capture
 * does not look like that window.
 *
 * The capture is the window plus its shadow. When nothing pokes past the
 * window's edge, the opaque pixels are exactly the window. A popover or menu
 * drawn past one edge widens the opaque area on that axis only, so the
 * smaller of the two pixels-per-point is the true scale, and the window sits
 * in one corner of the opaque area: the corner whose edges are real edges,
 * opaque just inside and shadow just outside.
 */
export function locateWindowFrame(image: Rgba, bounds: ScreenArea, pixelsPerPoint?: number): PixelRect | null {
  if (bounds.width <= 0 || bounds.height <= 0) return null
  const opaque = opaqueBounds(image)
  if (!opaque) return null
  const scaleX = opaque.width / bounds.width
  const scaleY = opaque.height / bounds.height
  // With the capture's own scale known, a window of another size cannot pass
  // for this one at some other scale (a popover the same shape, say).
  if (pixelsPerPoint && Math.min(scaleX, scaleY) < pixelsPerPoint * (1 - SCALE_TOLERANCE)) return null
  if (sameScale(scaleX, scaleY) && (!pixelsPerPoint || sameScale(scaleX, pixelsPerPoint))) return opaque

  const scale = pixelsPerPoint ?? Math.min(scaleX, scaleY)
  const width = Math.round(bounds.width * scale)
  const height = Math.round(bounds.height * scale)
  const right = opaque.x + opaque.width - width
  const bottom = opaque.y + opaque.height - height
  // A sheet wider than its window overhangs both sides, centred on it.
  const centre = opaque.x + Math.round((opaque.width - width) / 2)
  const corners = [
    { x: opaque.x, y: opaque.y },
    { x: right, y: opaque.y },
    { x: opaque.x, y: bottom },
    { x: right, y: bottom },
    { x: centre, y: opaque.y },
    { x: centre, y: bottom },
  ]
  const seen = new Set<string>()
  const fits = corners
    .filter((corner) => {
      const key = `${corner.x},${corner.y}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((corner) => ({ x: corner.x, y: corner.y, width, height }))
    .filter((rect) => realEdges(image, rect) >= 3)
  return fits.length === 1 ? fits[0] : null
}

/**
 * The widest invisible resize border a Windows window is given, in pixels
 * at 100% scaling (8 for a standard frame), with room to spare; it grows
 * with the display's scale (9 to 11 measured at 150%).
 */
const MAX_WINDOWS_BORDER_AT_100 = 12

/** How far, in pixels, a Windows border may differ from its twin and still count as one width. */
const WINDOWS_BORDER_SLACK = 1.5

/**
 * The screen area a Windows window capture shows, or null when the capture
 * does not look like that window.
 *
 * On Windows agent-desktop works in physical pixels: window bounds, point
 * commands and captures alike, one capture pixel to one screen pixel. Its
 * `scale_factor` is the display's DPI setting (1.5 at 150%), not a
 * conversion, and is used here only for how wide a border can be.
 *
 * A Windows capture has no shadow: it is the window's visible frame, opaque
 * edge to edge. The window's bounds (GetWindowRect) also take in its
 * invisible resize borders, one width on the left, right and bottom, and on
 * top too while it is maximized, so they are wider and taller than what the
 * capture shows.
 */
export function locateWindowsFrame(image: Pick<Rgba, 'width' | 'height'>, bounds: ScreenArea, displayScale?: number): ScreenArea | null {
  const maxBorder = MAX_WINDOWS_BORDER_AT_100 * Math.max(1, displayScale ?? 1)
  const side = (bounds.width - image.width) / 2
  const vertical = bounds.height - image.height
  if (side < -WINDOWS_BORDER_SLACK / 2 || side > maxBorder) return null
  const top = Math.abs(vertical - 2 * side) <= WINDOWS_BORDER_SLACK ? side : 0
  if (Math.abs(vertical - top - side) > WINDOWS_BORDER_SLACK) return null
  return { x: bounds.x + side, y: bounds.y + top, width: image.width, height: image.height }
}

function isOpaque(image: Rgba, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false
  return image.data[(y * image.width + x) * 4 + 3] >= OPAQUE
}

/** Where along an edge to look: clear of the rounded corners. */
const EDGE_SAMPLES = [0.2, 0.35, 0.5, 0.65, 0.8]

/**
 * How many of a rectangle's four sides are a window's edge: opaque just
 * inside and not just outside, at most of the points sampled along it.
 */
function realEdges(image: Rgba, rect: PixelRect): number {
  const right = rect.x + rect.width - 1
  const bottom = rect.y + rect.height - 1
  const side = (inside: (f: number) => [number, number], outside: (f: number) => [number, number]) =>
    EDGE_SAMPLES.filter((f) => isOpaque(image, ...inside(f)) && !isOpaque(image, ...outside(f))).length >= 3
  const atY = (f: number) => rect.y + Math.floor(rect.height * f)
  const atX = (f: number) => rect.x + Math.floor(rect.width * f)
  return [
    side((f) => [rect.x, atY(f)], (f) => [rect.x - 1, atY(f)]),
    side((f) => [right, atY(f)], (f) => [right + 1, atY(f)]),
    side((f) => [atX(f), rect.y], (f) => [atX(f), rect.y - 1]),
    side((f) => [atX(f), bottom], (f) => [atX(f), bottom + 1]),
  ].filter(Boolean).length
}

/**
 * Shrink a region of an RGBA image to `width` × `height` by averaging the
 * source pixels each output pixel covers (fractional edges weighted), one axis
 * at a time.
 */
function resample(image: Rgba, region: PixelRect, width: number, height: number): Uint8Array {
  const stepX = region.width / width
  const stepY = region.height / height
  // Horizontal pass: region rows × output columns.
  const rows = new Float32Array(region.height * width * 4)
  for (let y = 0; y < region.height; y++) {
    const source = (region.y + y) * image.width
    for (let ox = 0; ox < width; ox++) {
      const start = ox * stepX
      const end = Math.min(start + stepX, region.width)
      let r = 0, g = 0, b = 0, a = 0
      for (let sx = Math.floor(start); sx < end; sx++) {
        const weight = Math.min(sx + 1, end) - Math.max(sx, start)
        const i = (source + region.x + sx) * 4
        r += image.data[i] * weight
        g += image.data[i + 1] * weight
        b += image.data[i + 2] * weight
        a += image.data[i + 3] * weight
      }
      const o = (y * width + ox) * 4
      rows[o] = r / stepX
      rows[o + 1] = g / stepX
      rows[o + 2] = b / stepX
      rows[o + 3] = a / stepX
    }
  }
  // Vertical pass.
  const out = new Uint8Array(width * height * 4)
  for (let oy = 0; oy < height; oy++) {
    const start = oy * stepY
    const end = Math.min(start + stepY, region.height)
    for (let ox = 0; ox < width; ox++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = Math.floor(start); sy < end; sy++) {
        const weight = Math.min(sy + 1, end) - Math.max(sy, start)
        const i = (sy * width + ox) * 4
        r += rows[i] * weight
        g += rows[i + 1] * weight
        b += rows[i + 2] * weight
        a += rows[i + 3] * weight
      }
      const o = (oy * width + ox) * 4
      out[o] = Math.round(r / stepY)
      out[o + 1] = Math.round(g / stepY)
      out[o + 2] = Math.round(b / stepY)
      out[o + 3] = Math.round(a / stepY)
    }
  }
  return out
}

function encode(data: Uint8Array, width: number, height: number): Buffer {
  const png = new PNG({ width, height })
  png.data = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return PNG.sync.write(png)
}

function windowLabel(window: WindowCandidate): string {
  return window.app ? `window ${window.id} (${window.app})` : `window ${window.id}`
}

function overlaps(a: ScreenArea, b: ScreenArea): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/**
 * The focused window and the same app's windows over it (its sheets and
 * popovers), as one area, or null when it has none.
 */
function focusedWithAttached(candidates: readonly WindowCandidate[]): { window: WindowCandidate; label: string } | null {
  const focused = candidates.find((window) => window.focused)
  if (!focused) return null
  const attached = candidates.filter((window) => window !== focused && window.app === focused.app && overlaps(window.bounds, focused.bounds))
  if (attached.length === 0) return null
  const all = [focused, ...attached]
  const x = Math.min(...all.map((w) => w.bounds.x))
  const y = Math.min(...all.map((w) => w.bounds.y))
  const right = Math.max(...all.map((w) => w.bounds.x + w.bounds.width))
  const bottom = Math.max(...all.map((w) => w.bounds.y + w.bounds.height))
  return {
    window: { ...focused, bounds: { x, y, width: right - x, height: bottom - y } },
    label: `${windowLabel(focused)} with ${attached.map((w) => w.id).join(', ')} over it`,
  }
}

/**
 * Prepare a capture for the agent: crop a window's shadow, shrink it to what
 * the model takes, and say what screen area the result covers.
 */
export function prepareScreenshot(
  capture: Buffer,
  target: ScreenshotTarget | null,
  unknownTargetReason?: string,
  /**
   * agent-desktop's `scale_factor`, when it says: on macOS the capture's
   * pixels per point, on Windows the display's DPI setting (see locateWindowsFrame).
   */
  pixelsPerPoint?: number,
  /** The OS that took the capture: a Windows window capture has no shadow and its bounds take in borders it does not show. */
  platform: NodeJS.Platform = process.platform,
): PreparedScreenshot {
  const image = nativeDecoder?.(capture) ?? decodeInJavaScript(capture)
  let region: PixelRect = { x: 0, y: 0, width: image.width, height: image.height }
  let frame: ScreenshotFrame | null = null
  let unalignedReason = unknownTargetReason

  if (target?.kind === 'screen') {
    if (sameScale(image.width / target.bounds.width, image.height / target.bounds.height)) {
      frame = { area: target.bounds, label: target.label }
    } else {
      unalignedReason = `the image's shape does not match ${target.label}`
    }
  } else if (target?.kind === 'window') {
    type Fit = { window: WindowCandidate; rect: PixelRect; area: ScreenArea }
    const whole: PixelRect = { x: 0, y: 0, width: image.width, height: image.height }
    const fit = (window: WindowCandidate): Fit | null => {
      if (platform === 'win32') {
        const area = locateWindowsFrame(image, window.bounds, pixelsPerPoint)
        return area && { window, rect: whole, area }
      }
      const rect = locateWindowFrame(image, window.bounds, pixelsPerPoint)
      return rect && { window, rect, area: window.bounds }
    }
    let fits = target.candidates.map(fit).filter((entry): entry is Fit => entry !== null)
    // Two windows of one size both fit; a capture of the app shows the focused one.
    if (fits.length > 1) {
      const focused = fits.filter((fit) => fit.window.focused)
      if (focused.length === 1) fits = focused
    }
    // A sheet or popover larger than its window on two sides: the capture is
    // the focused window and the windows over it, together.
    let together: string | undefined
    if (fits.length === 0) {
      const union = focusedWithAttached(target.candidates)
      const joint = union && fit(union.window)
      if (union && joint) {
        fits = [joint]
        together = union.label
      }
    }
    if (fits.length === 1) {
      region = fits[0].rect
      frame = {
        area: fits[0].area,
        window: { id: fits[0].window.id, ...(fits[0].window.app && { app: fits[0].window.app }) },
        label: together ?? windowLabel(fits[0].window),
      }
    } else if (target.candidates.length === 0) {
      unalignedReason = 'the window it shows was not found in the window list'
    } else if (fits.length === 0) {
      unalignedReason = 'the window\'s edges could not be found in the image'
    } else {
      unalignedReason = 'it could show more than one window; take it with window_id'
    }
  }

  const size = fitImageSize(region.width, region.height)
  const whole = region.x === 0 && region.y === 0 && region.width === image.width && region.height === image.height
  const png = whole && size.width === image.width && size.height === image.height
    ? capture
    : image.shrink(region, size.width, size.height)
  return {
    png,
    width: size.width,
    height: size.height,
    frame,
    ...(!frame && unalignedReason && { unalignedReason }),
  }
}
