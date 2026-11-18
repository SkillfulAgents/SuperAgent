import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addImageThumbnails, type RecentFile, type ThumbnailImageApi } from './recent-file-thumbnails'

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
const WEBP_HEAD = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

/** A stand-in for a NativeImage whose PNG bytes are the given text. */
function fakeImage(label: string, empty = false) {
  const image = {
    isEmpty: () => empty,
    toPNG: () => Buffer.from(label),
    resize: vi.fn(() => fakeImage(`resized:${label}`)),
  }
  return image as unknown as Electron.NativeImage
}

function dataUrl(label: string): string {
  return `data:image/png;base64,${Buffer.from(label).toString('base64')}`
}

function fakeImages(overrides: Partial<Record<keyof ThumbnailImageApi, unknown>> = {}) {
  const images = {
    createFromPath: vi.fn((p: string) => fakeImage(`decoded:${path.basename(p)}`)),
    createThumbnailFromPath: vi.fn((p: string) => Promise.resolve(fakeImage(`os:${path.basename(p)}`))),
    ...overrides,
  }
  return images as typeof images & ThumbnailImageApi
}

describe('addImageThumbnails', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-thumbs-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function file(name: string, content?: Buffer | string): RecentFile {
    const filePath = path.join(dir, name)
    if (content !== undefined) fs.writeFileSync(filePath, content)
    return { name, path: filePath }
  }

  describe('on macOS', () => {
    const mac = { platform: 'darwin' as const }

    it('asks the OS thumbnailer and never decodes a file in this process', async () => {
      const images = fakeImages()
      const files = [file('a.png', PNG_HEAD), file('b.JPG', JPEG_HEAD), file('c.webp', WEBP_HEAD)]

      const result = await addImageThumbnails(files, images, mac)

      expect(result).toEqual([
        { ...files[0], thumbnail: dataUrl('os:a.png') },
        { ...files[1], thumbnail: dataUrl('os:b.JPG') },
        { ...files[2], thumbnail: dataUrl('os:c.webp') },
      ])
      expect(images.createFromPath).not.toHaveBeenCalled()
      expect(images.createThumbnailFromPath).toHaveBeenCalledWith(files[0].path, { width: 64, height: 64 })
    })

    it('keeps the order and leaves files that are not images alone', async () => {
      const images = fakeImages()
      const files = [file('notes.txt', 'hello'), file('a.png', PNG_HEAD), file('report.pdf', '%PDF')]

      const result = await addImageThumbnails(files, images, mac)

      expect(result).toEqual([files[0], { ...files[1], thumbnail: dataUrl('os:a.png') }, files[2]])
      expect(images.createThumbnailFromPath).toHaveBeenCalledTimes(1)
    })

    it('does not ask for a file that is not really an image, which the OS would answer with a document icon', async () => {
      const images = fakeImages()
      const files = [file('corrupt.png', 'this is not a png'), file('empty.jpg', '')]

      expect(await addImageThumbnails(files, images, mac)).toEqual(files)
      expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
    })

    it('lists a missing file, a rejected thumbnail and an empty one without a thumbnail', async () => {
      const images = fakeImages({
        createThumbnailFromPath: vi.fn((p: string) =>
          p.endsWith('rejected.png') ? Promise.reject(new Error('unable to retrieve thumbnail')) : Promise.resolve(fakeImage('x', true)),
        ),
      })
      const files = [file('missing.png'), file('rejected.png', PNG_HEAD), file('blank.png', PNG_HEAD)]

      expect(await addImageThumbnails(files, images, mac)).toEqual(files)
    })

    it('gives up on a thumbnail that does not arrive and still returns the rest', async () => {
      const images = fakeImages({
        createThumbnailFromPath: vi.fn((p: string) =>
          p.endsWith('stuck.png') ? new Promise<Electron.NativeImage>(() => {}) : Promise.resolve(fakeImage('ok')),
        ),
      })
      const files = [file('stuck.png', PNG_HEAD), file('ok.png', PNG_HEAD)]

      const result = await addImageThumbnails(files, images, { ...mac, timeoutMs: 20 })

      expect(result).toEqual([files[0], { ...files[1], thumbnail: dataUrl('ok') }])
    })

    it('asks for at most four thumbnails at a time', async () => {
      let running = 0
      let most = 0
      const images = fakeImages({
        createThumbnailFromPath: vi.fn(async () => {
          running++
          most = Math.max(most, running)
          await new Promise((resolve) => setTimeout(resolve, 5))
          running--
          return fakeImage('t')
        }),
      })
      const files = Array.from({ length: 20 }, (_, i) => file(`p${i}.png`, PNG_HEAD))

      const result = await addImageThumbnails(files, images, mac)

      expect(result.every((f) => f.thumbnail === dataUrl('t'))).toBe(true)
      expect(most).toBe(4)
    })
  })

  describe('on Windows', () => {
    const windows = { platform: 'win32' as const }

    it('decodes the file and resizes it to 32 px wide, as before', async () => {
      const decoded = fakeImage('decoded')
      const images = fakeImages({ createFromPath: vi.fn(() => decoded) })
      const files = [file('a.png', PNG_HEAD), file('notes.txt', 'hello')]

      const result = await addImageThumbnails(files, images, windows)

      expect(result).toEqual([{ ...files[0], thumbnail: dataUrl('resized:decoded') }, files[1]])
      expect(decoded.resize).toHaveBeenCalledWith({ width: 32, quality: 'good' })
      expect(images.createThumbnailFromPath).not.toHaveBeenCalled()
    })

    it('lists a file that does not decode without a thumbnail', async () => {
      const images = fakeImages({ createFromPath: vi.fn(() => fakeImage('x', true)) })
      const files = [file('corrupt.png', 'nope')]

      expect(await addImageThumbnails(files, images, windows)).toEqual(files)
    })
  })
})
