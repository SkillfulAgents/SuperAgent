import { crc32 } from 'node:zlib'
import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { imageService, UnreadableImageError } from './image-service'

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

describe('local image service', () => {
  it('re-encodes a PNG without its text chunks and keeps its pixels', async () => {
    const image = new PNG({ width: 2, height: 2 })
    image.data.fill(40)
    const plain = PNG.sync.write(image)
    const ihdrEnd = 8 + 25
    const tagged = Buffer.concat([plain.subarray(0, ihdrEnd), chunk('tEXt', Buffer.from('Comment\0private note')), plain.subarray(ihdrEnd)])

    const clean = Buffer.from(await imageService().cleanPng(tagged))

    expect(tagged.includes('tEXt')).toBe(true)
    expect(clean.includes('tEXt')).toBe(false)
    expect(PNG.sync.read(clean).data.equals(image.data)).toBe(true)
  })

  it('throws UnreadableImageError for bytes that are not a PNG', async () => {
    await expect(imageService().cleanPng(new TextEncoder().encode('not a png'))).rejects.toBeInstanceOf(UnreadableImageError)
  })
})
