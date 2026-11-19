import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { resizeScreenshot } from './image-utils'

const blank = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: '#123456' } }).png().toBuffer()

describe('resizeScreenshot', () => {
  it('leaves an image within the limits as it is', async () => {
    const input = await blank(1280, 720)
    const result = await resizeScreenshot(input, 'image/png')
    expect(result).toEqual({ data: input, mimeType: 'image/png', resized: false })
  })

  it('applies the pixel limit to a large image', async () => {
    const { data } = await resizeScreenshot(await blank(2560, 1440), 'image/png')
    expect(await sharp(data).metadata()).toMatchObject({ width: 1461, height: 822 })
  })

  it('brings a 2x capture to its CSS size, below the limits', async () => {
    const { data, resized } = await resizeScreenshot(await blank(2560, 1440), 'image/png', 1 / 2)
    expect(resized).toBe(true)
    expect(await sharp(data).metadata()).toMatchObject({ width: 1280, height: 720 })
  })

  it('still applies the limits after the scale', async () => {
    const { data } = await resizeScreenshot(await blank(3840, 2160), 'image/png', 1 / 2)
    expect(await sharp(data).metadata()).toMatchObject({ width: 1461, height: 822 })
  })

  it.each([
    [800, 3200, 392, 1568],
    [3200, 800, 1568, 392],
  ])('fits a %ix%i screenshot without changing its aspect ratio', async (width, height, outWidth, outHeight) => {
    const result = await resizeScreenshot(await blank(width, height), 'image/png')
    expect(result.resized).toBe(true)
    expect(await sharp(result.data).metadata()).toMatchObject({ width: outWidth, height: outHeight })
  })

  it('keeps a small JPEG unchanged, including its MIME type', async () => {
    const input = await sharp(await blank(640, 480)).jpeg().toBuffer()
    const result = await resizeScreenshot(input, 'image/jpeg')
    expect(result.data).toBe(input)
    expect(result).toMatchObject({ mimeType: 'image/jpeg', resized: false })
  })

  it('returns PNG bytes and MIME type when a JPEG needs resizing', async () => {
    const input = await sharp(await blank(2560, 1440)).jpeg().toBuffer()
    const result = await resizeScreenshot(input, 'image/jpeg')
    expect(result).toMatchObject({ mimeType: 'image/png', resized: true })
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'png', width: 1461, height: 822 })
  })

  it('preserves transparency when shrinking a HiDPI screenshot', async () => {
    const input = await sharp({
      create: { width: 1600, height: 1200, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 0.5 } },
    }).png().toBuffer()
    const result = await resizeScreenshot(input, 'image/png', 1 / 2)
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true })
    expect(result.resized).toBe(true)
    expect(info).toMatchObject({ width: 800, height: 600, channels: 4 })
    expect(data[3]).toBe(128)
  })

  it('preserves the original payload when the image cannot be decoded', async () => {
    const input = Buffer.from('invalid screenshot')
    const result = await resizeScreenshot(input, 'image/jpeg')
    expect(result.data).toBe(input)
    expect(result).toMatchObject({ mimeType: 'image/jpeg', resized: false })
  })

  it('preserves the original when metadata can be read but resizing fails', async () => {
    const png = await blank(2560, 1440)
    const input = png.subarray(0, Math.floor(png.length / 2))
    expect(await sharp(input).metadata()).toMatchObject({ width: 2560, height: 1440 })
    const result = await resizeScreenshot(input, 'image/png')
    expect(result.data).toBe(input)
    expect(result).toMatchObject({ mimeType: 'image/png', resized: false })
  })
})
