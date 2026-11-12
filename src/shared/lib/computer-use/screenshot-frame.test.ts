import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import {
  fitImageSize,
  locateWindowFrame,
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
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
