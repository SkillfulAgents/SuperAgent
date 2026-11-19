import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import {
  fitImageSize,
  locateWindowFrame,
  locateWindowsFrame,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  opaqueBounds,
  prepareScreenshot,
  setCaptureDecoder,
} from './screenshot-frame'

interface Margins {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * A window capture as macOS makes one: an opaque window of `width` × `height`
 * pixels inside a transparent shadow margin, its pixels coloured by position
 * so a crop and a resize can be checked.
 */
function windowCapture(width: number, height: number, margins: Margins): PNG {
  const png = new PNG({ width: width + margins.left + margins.right, height: height + margins.top + margins.bottom })
  png.data.fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((y + margins.top) * png.width + x + margins.left) * 4
      png.data[i] = x < width / 2 ? 255 : 0
      png.data[i + 1] = y < height / 2 ? 255 : 0
      png.data[i + 2] = 128
      png.data[i + 3] = 255
    }
  }
  return png
}

/** Paint an opaque block (a popover drawn into the shadow). */
function paint(png: PNG, x: number, y: number, width: number, height: number): void {
  for (let row = y; row < y + height; row++) {
    for (let col = x; col < x + width; col++) {
      const i = (row * png.width + col) * 4
      png.data[i] = 10
      png.data[i + 1] = 10
      png.data[i + 2] = 10
      png.data[i + 3] = 255
    }
  }
}

// The shadow of a focused window, as measured on a real capture (2× display):
// even left and right, deeper below than above.
const FOCUSED_SHADOW: Margins = { left: 112, right: 112, top: 78, bottom: 150 }

// Captures are macOS's unless a test names another OS, whatever this machine runs.
const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => { Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }) })
afterEach(() => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) })

describe('fitImageSize', () => {
  it('leaves a small image alone', () => {
    expect(fitImageSize(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('shrinks a Retina window capture to what the model takes, keeping its shape', () => {
    const { width, height } = fitImageSize(3252, 2672)
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE)
    expect(width * height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS)
    expect(width / height).toBeCloseTo(3252 / 2672, 2)
  })

  it('shrinks a Retina display capture to no more pixels than XGA', () => {
    const { width, height } = fitImageSize(3024, 1964)
    expect(width * height).toBeLessThanOrEqual(1024 * 768)
    expect(width * height).toBeGreaterThan(1024 * 768 * 0.99)
  })
})

describe('locateWindowFrame', () => {
  const bounds = { x: 738, y: 30, width: 400, height: 300 }

  it('finds the window inside its shadow', () => {
    const capture = windowCapture(800, 600, FOCUSED_SHADOW)
    expect(locateWindowFrame(capture, bounds)).toEqual({ x: 112, y: 78, width: 800, height: 600 })
  })

  it('finds it when a popover pokes out into the shadow', () => {
    const capture = windowCapture(800, 600, FOCUSED_SHADOW)
    paint(capture, 112 + 700, 78 + 40, 150, 200)
    expect(locateWindowFrame(capture, bounds)).toEqual({ x: 112, y: 78, width: 800, height: 600 })
  })

  it('takes a capture with no shadow as the window itself', () => {
    const capture = windowCapture(800, 600, { left: 0, right: 0, top: 0, bottom: 0 })
    expect(locateWindowFrame(capture, bounds)).toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('finds nothing in a capture of another shape', () => {
    const capture = windowCapture(800, 600, FOCUSED_SHADOW)
    expect(locateWindowFrame(capture, { ...bounds, width: 600, height: 600 })).toBeNull()
  })
})

describe('prepareScreenshot', () => {
  const window = { id: 'w-5', app: 'Safari', bounds: { x: 738, y: 30, width: 400, height: 300 } }

  it('crops the shadow and says the image is that window', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [window] })

    expect(prepared.frame).toEqual({ area: window.bounds, window: { id: 'w-5', app: 'Safari' }, label: 'window w-5 (Safari)' })
    expect({ width: prepared.width, height: prepared.height }).toEqual({ width: 800, height: 600 })
    const image = PNG.sync.read(prepared.png)
    // No shadow left: every corner of the window is opaque, coloured as drawn.
    expect(image.data[3]).toBe(255)
    expect([image.data[0], image.data[1]]).toEqual([255, 255])
    const last = (image.width * image.height - 1) * 4
    expect([image.data[last], image.data[last + 1], image.data[last + 3]]).toEqual([0, 0, 255])
  })

  it('shrinks a large capture to what the model takes', () => {
    const capture = PNG.sync.write(windowCapture(3252, 2672, FOCUSED_SHADOW))
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [{ ...window, bounds: { ...window.bounds, width: 1626, height: 1336 } }] })

    expect(prepared.width * prepared.height).toBeLessThanOrEqual(MAX_IMAGE_PIXELS)
    expect(prepared.frame?.area.width).toBe(1626)
    const image = PNG.sync.read(prepared.png)
    expect([image.width, image.height]).toEqual([prepared.width, prepared.height])
  })

  it('picks the one window of an app that the capture fits', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const other = { id: 'w-6', app: 'Safari', bounds: { x: 0, y: 0, width: 300, height: 300 } }
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [other, window] }).frame?.window?.id).toBe('w-5')
  })

  it('will not guess between two windows the capture fits', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const twin = { ...window, id: 'w-6', bounds: { ...window.bounds, x: 0 } }
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [window, twin] })
    expect(prepared.frame).toBeNull()
    expect(prepared.unalignedReason).toMatch(/window_id/)
  })

  it('lines a display capture up with the display', () => {
    const capture = PNG.sync.write(windowCapture(1024, 576, { left: 0, right: 0, top: 0, bottom: 0 }))
    const display = { x: 2560, y: 0, width: 512, height: 288 }
    const prepared = prepareScreenshot(capture, { kind: 'screen', bounds: display, label: 'display 1' })
    expect(prepared.frame).toEqual({ area: display, label: 'display 1' })
  })

  it('with the capture\'s scale, does not take a window of another size the same shape for this one', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    // A popover a quarter the size fits too, at four pixels per point.
    const popover = { id: 'w-9', app: 'Safari', bounds: { x: 900, y: 80, width: 200, height: 150 } }
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [window, popover] }).frame).toBeNull()
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [window, popover] }, undefined, 2).frame?.window?.id).toBe('w-5')
  })

  it('finds a window under a sheet that overhangs both its sides', () => {
    const png = windowCapture(800, 600, FOCUSED_SHADOW)
    paint(png, 112 - 60, 78 + 20, 920, 120)
    const prepared = prepareScreenshot(PNG.sync.write(png), { kind: 'window', candidates: [window] }, undefined, 2)
    expect(prepared.frame?.window?.id).toBe('w-5')
    expect({ width: prepared.width, height: prepared.height }).toEqual({ width: 800, height: 600 })
  })

  it('places a capture of a window under a sheet larger than it on two sides, as the two together', () => {
    // The window is 400x300 points at 2x; its sheet, 460x320 points, sticks out left, right and below.
    const png = windowCapture(800, 600, FOCUSED_SHADOW)
    const grown = new PNG({ width: png.width, height: png.height + 80 })
    png.data.copy(grown.data)
    paint(grown, 112 - 60, 78 + 40, 920, 640)
    const sheet = { id: 'w-8', app: 'Safari', bounds: { x: 708, y: 50, width: 460, height: 320 } }
    const prepared = prepareScreenshot(PNG.sync.write(grown), { kind: 'window', candidates: [{ ...window, focused: true }, sheet] }, undefined, 2)
    expect(prepared.frame).toMatchObject({ area: { x: 708, y: 30, width: 460, height: 340 }, label: 'window w-5 (Safari) with w-8 over it' })
  })

  it('takes the focused one of two windows of one size', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const twin = { ...window, id: 'w-6', bounds: { ...window.bounds, x: 0 } }
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [window, { ...twin, focused: true }] }, undefined, 2)
    expect(prepared.frame?.window?.id).toBe('w-6')
  })

  it('uses the native decoder when there is one, and JavaScript when it cannot read a capture', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const decoded = PNG.sync.read(capture)
    const shrinks: unknown[] = []
    try {
      setCaptureDecoder(() => ({
        width: decoded.width,
        height: decoded.height,
        data: decoded.data,
        shrink: (region, width, height) => {
          shrinks.push({ region, width, height })
          return Buffer.from('native')
        },
      }))
      const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [window] })
      expect(shrinks).toEqual([{ region: { x: 112, y: 78, width: 800, height: 600 }, width: 800, height: 600 }])
      expect(prepared.png.toString()).toBe('native')

      setCaptureDecoder(() => null)
      expect(PNG.sync.read(prepareScreenshot(capture, { kind: 'window', candidates: [window] }).png).width).toBe(800)
    } finally {
      setCaptureDecoder(null)
    }
  })

  it('says why when it cannot line an image up', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    expect(prepareScreenshot(capture, null, 'it names no window').unalignedReason).toBe('it names no window')
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [] }).frame).toBeNull()
  })
})

/** The opaque bounds as they were first found, every pixel read: what the faster reading must agree with. */
function opaqueBoundsReadingEveryPixel(image: { width: number; height: number; data: Uint8Array }) {
  let minX = image.width
  let minY = image.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] < 250) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** The same pixels, counting how many of them are read. */
function countingReads<T extends Uint8Array>(data: T): { data: T; counts: { pixelReads: number } } {
  const counts = { pixelReads: 0 }
  const counted = new Proxy(data, {
    get: (target, key) => {
      if (typeof key === 'string' && /^\d+$/.test(key)) counts.pixelReads++
      return Reflect.get(target, key, target)
    },
  })
  return { data: counted, counts }
}

describe('opaqueBounds', () => {
  const blank = (width: number, height: number) => ({ width, height, data: new Uint8Array(width * height * 4) })

  it('finds what reading every pixel finds, whatever the image', () => {
    // A repeatable stream of numbers.
    let state = 7
    const upTo = (n: number) => {
      state = (state * 1664525 + 1013904223) >>> 0
      return Math.floor((state / 2 ** 32) * n)
    }
    for (let round = 0; round < 500; round++) {
      const image = blank(1 + upTo(24), 1 + upTo(24))
      // Nothing, lone pixels, or blocks, some of them only nearly opaque.
      const shapes = upTo(5)
      for (let shape = 0; shape < shapes; shape++) {
        const x = upTo(image.width)
        const y = upTo(image.height)
        const width = round % 2 ? 1 : 1 + upTo(image.width - x)
        const height = round % 2 ? 1 : 1 + upTo(image.height - y)
        const alpha = [255, 250, 249, 120][upTo(4)]
        for (let row = y; row < y + height; row++) {
          for (let col = x; col < x + width; col++) image.data[(row * image.width + col) * 4 + 3] = alpha
        }
      }
      expect(opaqueBounds(image), `round ${round}`).toEqual(opaqueBoundsReadingEveryPixel(image))
    }
  })

  it('finds a window in its shadow, with and without things drawn past its edges', () => {
    const capture = windowCapture(800, 600, FOCUSED_SHADOW)
    expect(opaqueBounds(capture)).toEqual({ x: 112, y: 78, width: 800, height: 600 })
    paint(capture, 112 + 700, 78 + 40, 150, 200)
    paint(capture, 40, 78 + 560, 100, 90)
    expect(opaqueBounds(capture)).toEqual({ x: 40, y: 78, width: 922, height: 650 })
    expect(opaqueBounds(capture)).toEqual(opaqueBoundsReadingEveryPixel(capture))
  })

  it('finds nothing in an image with no opaque pixel, or no pixel', () => {
    expect(opaqueBounds(blank(40, 30))).toBeNull()
    expect(opaqueBounds(blank(0, 0))).toBeNull()
  })

  it('reads a window capture\'s shadow, not the window', () => {
    const capture = windowCapture(800, 600, FOCUSED_SHADOW)
    const { data, counts } = countingReads(capture.data)
    expect(opaqueBounds({ width: capture.width, height: capture.height, data })).toEqual({ x: 112, y: 78, width: 800, height: 600 })
    // The rows above and below the window, and the two margins of each of its rows.
    const shadow = capture.width * (FOCUSED_SHADOW.top + FOCUSED_SHADOW.bottom + 2) + capture.height * (FOCUSED_SHADOW.left + FOCUSED_SHADOW.right + 2)
    expect(counts.pixelReads).toBeLessThanOrEqual(shadow)
    expect(counts.pixelReads).toBeLessThan((capture.width * capture.height) / 2)
  })
})

describe('what prepareScreenshot reads of a capture', () => {
  const window = { id: 'w-5', app: 'Safari', bounds: { x: 738, y: 30, width: 400, height: 300 } }
  // Windows of other sizes, none of which the capture shows.
  const others = Array.from({ length: 8 }, (_, i) => ({ id: `w-${20 + i}`, app: 'Finder', bounds: { x: 10 * i, y: 0, width: 300 + 10 * i, height: 300 } }))

  /**
   * A decoder as Electron's is, its pixels made when first asked for. Counts
   * the times they are asked for and the pixels read; its shrink says what
   * it was asked to cut out.
   */
  function countingDecoder(capture: Buffer) {
    const decoded = PNG.sync.read(capture)
    const { data, counts: reads } = countingReads(decoded.data)
    const counts = { bitmaps: 0, reads }
    setCaptureDecoder(() => ({
      width: decoded.width,
      height: decoded.height,
      get data() {
        counts.bitmaps++
        return data
      },
      shrink: (region, width, height) => Buffer.from(JSON.stringify({ region, width, height })),
    }))
    return counts
  }

  afterEach(() => setCaptureDecoder(null))

  it('does not ask for a display capture\'s pixels', () => {
    const capture = PNG.sync.write(windowCapture(1024, 576, { left: 0, right: 0, top: 0, bottom: 0 }))
    const counts = countingDecoder(capture)
    const display = { x: 0, y: 0, width: 512, height: 288 }
    expect(prepareScreenshot(capture, { kind: 'screen', bounds: display, label: 'display 0' }).frame?.area).toEqual(display)
    expect(counts.bitmaps).toBe(0)
  })

  it('does not ask for them when it does not know what the capture shows, or on Windows', () => {
    const capture = PNG.sync.write(windowCapture(1101, 1464, { left: 0, right: 0, top: 0, bottom: 0 }))
    const counts = countingDecoder(capture)
    prepareScreenshot(capture, null, 'it names no window')
    const chrome = { id: 'w-921266', app: 'chrome.exe', bounds: { x: -9, y: 0, width: 1119, height: 1473 } }
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [chrome] }, undefined, 1.5, 'win32').frame?.window?.id).toBe('w-921266')
    expect(counts.bitmaps).toBe(0)
  })

  it('asks for a window capture\'s pixels once, and finds the opaque ones once, however many windows it could show', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))

    const alone = countingDecoder(capture)
    const one = prepareScreenshot(capture, { kind: 'window', candidates: [window] }, undefined, 2)
    expect(alone.bitmaps).toBe(1)

    const among = countingDecoder(capture)
    const many = prepareScreenshot(capture, { kind: 'window', candidates: [...others, window] }, undefined, 2)
    expect(among.bitmaps).toBe(1)
    // A window tried and not found costs the pixels sampled along its edges
    // (six places it could sit, four sides, five samples, inside and out),
    // not the image again.
    expect(among.reads.pixelReads - alone.reads.pixelReads).toBeLessThanOrEqual(others.length * 6 * 4 * 5 * 2)

    expect(many.frame).toEqual(one.frame)
    expect(many.png.toString()).toBe(JSON.stringify({ region: { x: 112, y: 78, width: 800, height: 600 }, width: 800, height: 600 }))
    expect(many.png.equals(one.png)).toBe(true)
  })

  it('makes the same image whether the pixels come at once or when asked for: the window\'s own, byte for byte', () => {
    const png = windowCapture(800, 600, FOCUSED_SHADOW)
    paint(png, 112 + 700, 78 + 40, 150, 200)
    const capture = PNG.sync.write(png)
    // The window cut out by hand.
    const cut = new PNG({ width: 800, height: 600 })
    PNG.bitblt(png, cut, 112, 78, 800, 600, 0, 0)
    const other = { id: 'w-6', app: 'Safari', bounds: { x: 0, y: 0, width: 300, height: 200 } }

    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [other, window] }, undefined, 2)
    expect(prepared.frame?.window?.id).toBe('w-5')
    expect(prepared.png.equals(PNG.sync.write(cut))).toBe(true)

    // A decoder whose pixels come when asked for is asked to cut out the same region.
    countingDecoder(capture)
    const lazy = prepareScreenshot(capture, { kind: 'window', candidates: [other, window] }, undefined, 2)
    expect(lazy.frame).toEqual(prepared.frame)
    expect(lazy.png.toString()).toBe(JSON.stringify({ region: { x: 112, y: 78, width: 800, height: 600 }, width: 800, height: 600 }))
  })

  it('leaves a capture to the JavaScript decoder when the native pixels are not four bytes each', () => {
    const capture = PNG.sync.write(windowCapture(800, 600, FOCUSED_SHADOW))
    const expected = prepareScreenshot(capture, { kind: 'window', candidates: [window] })
    setCaptureDecoder(() => ({
      width: 1024,
      height: 828,
      data: new Uint8Array(1024 * 828 * 3),
      shrink: () => Buffer.from('native'),
    }))
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [window] })
    expect(prepared.frame).toEqual(expected.frame)
    expect(prepared.png.equals(expected.png)).toBe(true)
  })
})

describe('Windows window captures', () => {
  // Measured at 150% scaling, agent-desktop 1.1.0, checked against DWM's
  // frame bounds: the capture is the visible frame, one pixel per physical
  // pixel (agent-desktop's coordinates), and scale_factor 1.5 is the DPI setting.
  const NO_SHADOW: Margins = { left: 0, right: 0, top: 0, bottom: 0 }
  const chrome = { id: 'w-921266', app: 'chrome.exe', bounds: { x: -9, y: 0, width: 1119, height: 1473 } }
  const slack = { id: 'w-12', app: 'Slack.exe', bounds: { x: -11, y: -11, width: 2326, height: 1486 } }

  it('leaves the invisible borders off a window\'s left, right and bottom', () => {
    expect(locateWindowsFrame({ width: 1101, height: 1464 }, chrome.bounds, 1.5)).toEqual({ x: 0, y: 0, width: 1101, height: 1464 })
  })

  it('leaves them off the top too while the window is maximized', () => {
    expect(locateWindowsFrame({ width: 2304, height: 1464 }, slack.bounds, 1.5)).toEqual({ x: 0, y: 0, width: 2304, height: 1464 })
  })

  it('allows wider borders on a display of a higher scale', () => {
    // 15-pixel borders, as a standard frame has at 200%.
    const bounds = { x: 85, y: 100, width: 1030, height: 815 }
    expect(locateWindowsFrame({ width: 1000, height: 800 }, bounds, 2)).toEqual({ x: 100, y: 100, width: 1000, height: 800 })
    expect(locateWindowsFrame({ width: 1000, height: 800 }, bounds, 1)).toBeNull()
  })

  it('takes a window with no border as its own frame', () => {
    expect(locateWindowsFrame({ width: 800, height: 600 }, { x: 10, y: 20, width: 800, height: 600 }, 1.5)).toEqual({ x: 10, y: 20, width: 800, height: 600 })
  })

  it('finds nothing in a capture of another window\'s size', () => {
    expect(locateWindowsFrame({ width: 1203, height: 1464 }, chrome.bounds, 1.5)).toBeNull()
    expect(locateWindowsFrame({ width: 1101, height: 1300 }, chrome.bounds, 1.5)).toBeNull()
  })

  it('says which screen points the image shows, without the borders', () => {
    const capture = PNG.sync.write(windowCapture(1101, 1464, NO_SHADOW))
    const prepared = prepareScreenshot(capture, { kind: 'window', candidates: [chrome] }, undefined, 1.5, 'win32')
    expect(prepared.frame).toEqual({
      area: { x: 0, y: 0, width: 1101, height: 1464 },
      window: { id: 'w-921266', app: 'chrome.exe' },
      label: 'window w-921266 (chrome.exe)',
    })
    // The same capture on macOS's rules finds no window: what failed before.
    expect(prepareScreenshot(capture, { kind: 'window', candidates: [chrome] }, undefined, 1.5, 'darwin').frame).toBeNull()
  })
})
