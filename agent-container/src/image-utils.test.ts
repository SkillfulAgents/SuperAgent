import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { resizeScreenshot } from './image-utils'

async function png(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer()
}

async function size(buffer: Buffer): Promise<string> {
  const { width, height } = await sharp(buffer).metadata()
  return `${width}x${height}`
}

describe('resizeScreenshot pixelRatio', () => {
  it('brings a 1.5x browser capture back to the 1280x720 viewport', async () => {
    const result = await resizeScreenshot(await png(1920, 1080), 'image/png', { pixelRatio: 1.5 })
    expect(result.resized).toBe(true)
    expect(await size(result.data)).toBe('1280x720')
  })

  it('leaves a 1x capture unchanged', async () => {
    const input = await png(1280, 720)
    const result = await resizeScreenshot(input, 'image/png', { pixelRatio: 1 })
    expect(result.resized).toBe(false)
    expect(result.data).toBe(input)
  })
})
