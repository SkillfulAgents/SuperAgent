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
})
