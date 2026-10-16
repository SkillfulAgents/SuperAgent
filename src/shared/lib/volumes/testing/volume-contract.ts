import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseMountableVolume } from '../base-mountable-volume'

/** A provider fixture supplies an independent view of remote state and failure
 * injection. Tests exercise the real adapter/client, not a fake filesystem API.
 * Future adapters can register here without copying the behavioral assertions. */
export interface VolumeContractFixture {
  volume(): BaseMountableVolume<unknown>
  put(path: string, bytes: Uint8Array): void
  mkdir(path: string): void
  bytes(path: string): Uint8Array | undefined
  exists(path: string): boolean
  failWrite(): void
  beforeCommit(run: () => void): void
  revoke(): void
  count(kind: 'content' | 'health' | 'list', path?: string): number
}
const bytes = (text: string) => new TextEncoder().encode(text)
const body = (text: string) => new Blob([text]).stream()
async function read(f: VolumeContractFixture, path: string): Promise<Uint8Array> {
  return new Uint8Array(await new Response(await (await f.volume().read(path)).stream()).arrayBuffer())
}

export function volumeContract(label: string, create: () => VolumeContractFixture): void {
  describe(`${label}: mounted folder contract`, () => {
    let f: VolumeContractFixture
    beforeEach(() => { f = create() })

    it.each([0, 1, 512 * 1024, 512 * 1024 + 1, 2 * 1024 * 1024])('round-trips %i binary bytes and uses one content request through 512 KiB', async size => {
      const content = Uint8Array.from({ length: size }, (_, i) => i % 256)
      await f.volume().write('café.bin', new Blob([content]).stream())
      expect(Buffer.from(f.bytes('café.bin')!).equals(Buffer.from(content))).toBe(true)
      expect((await f.volume().stat('café.bin')).size).toBe(size)
      expect(Buffer.from(await read(f, 'café.bin')).equals(Buffer.from(content))).toBe(true)
      if (size <= 512 * 1024) expect(f.count('content')).toBe(1)
    })

    it('replaces a file and exposes the new contents in a warm directory', async () => {
      f.put('file', bytes('before'))
      await f.volume().list('')
      await f.volume().write('file', body('after'))
      expect(f.bytes('file')).toEqual(bytes('after'))
      expect((await f.volume().list('')).find(file => file.name === 'file')?.size).toBe(5)
    })

    it('returns fresh stat and read sizes after an external edit', async () => {
      f.put('file', bytes('old'))
      await f.volume().list('')
      f.put('file', bytes('new and longer'))
      expect((await f.volume().stat('file')).size).toBe(14)
      expect(await read(f, 'file')).toEqual(bytes('new and longer'))
    })

    it('serves the requested byte range and allows a metadata-only close', async () => {
      f.put('file', bytes('hello world'))
      const opened = await f.volume().read('file')
      expect(await new Response(await opened.stream({ start: 6, end: 10 })).text()).toBe('world')
      await expect(opened.stream()).rejects.toThrow('consumed')
      await (await f.volume().read('file')).close()
    })

    it('creates folders, refuses duplicates, and deletes only empty folders', async () => {
      await f.volume().mkdir('dir')
      await expect(f.volume().mkdir('dir')).rejects.toMatchObject({ code: 'already-exists' })
      await f.volume().write('dir/file', body('keep'))
      await expect(f.volume().delete('dir')).rejects.toMatchObject({ code: 'not-empty' })
      expect(f.bytes('dir/file')).toEqual(bytes('keep'))
      await f.volume().delete('dir/file')
      await f.volume().delete('dir')
      expect(f.exists('dir')).toBe(false)
    })

    it('renames files and replaces an occupied file without losing the source contents', async () => {
      f.put('temporary', bytes('new contents'))
      f.put('saved', bytes('previous contents'))
      await f.volume().move('temporary', 'saved')
      expect(f.bytes('saved')).toEqual(bytes('new contents'))
      expect(f.exists('temporary')).toBe(false)
      await f.volume().move('saved', 'renamed')
      expect(f.bytes('renamed')).toEqual(bytes('new contents'))
    })

    it('never replaces an occupied folder or moves a folder inside itself', async () => {
      f.mkdir('dir')
      f.put('dir/keep', bytes('keep'))
      f.put('file', bytes('new'))
      await expect(f.volume().move('file', 'dir')).rejects.toMatchObject({ code: 'already-exists' })
      await expect(f.volume().move('dir', 'dir/child')).rejects.toMatchObject({ code: 'invalid-path' })
      expect(f.bytes('dir/keep')).toEqual(bytes('keep'))
    })

    it('does not manufacture missing parents', async () => {
      await expect(f.volume().write('missing/file', body('x'))).rejects.toMatchObject({ code: 'not-found' })
      await expect(f.volume().mkdir('missing/dir')).rejects.toMatchObject({ code: 'not-found' })
      expect(f.exists('missing')).toBe(false)
    })

    it('refuses every root mutation', async () => {
      for (const run of [() => f.volume().write('', body('x')), () => f.volume().mkdir(''), () => f.volume().delete(''), () => f.volume().move('', 'x')]) {
        await expect(run()).rejects.toMatchObject({ code: 'invalid-path' })
      }
    })

    it('preserves the old file when the incoming body fails', async () => {
      f.put('file', bytes('keep'))
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes('partial')); c.error(new Error('disconnected')) } })
      await expect(f.volume().write('file', stream)).rejects.toThrow('disconnected')
      expect(f.bytes('file')).toEqual(bytes('keep'))
    })

    it('preserves an existing file through a refused upload and delayed rclone cleanup', async () => {
      f.put('file', bytes('keep'))
      f.failWrite()
      await expect(f.volume().write('file', body('replacement'))).rejects.toThrow()
      const now = Date.now()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 60_000)
      try { await expect(f.volume().delete('file')).rejects.toMatchObject({ status: 409 }) }
      finally { clock.mockRestore() }
      expect(f.bytes('file')).toEqual(bytes('keep'))
      await f.volume().delete('file')
      expect(f.exists('file')).toBe(false)
    })

    it('does not let an old failed upload cleanup delete a subsequent successful write', async () => {
      f.put('file', bytes('old'))
      f.failWrite()
      await expect(f.volume().write('file', body('failed'))).rejects.toThrow()
      await f.volume().write('file', body('new'))
      await expect(f.volume().delete('file')).rejects.toMatchObject({ status: 409 })
      expect(f.bytes('file')).toEqual(bytes('new'))
    })

    it('cancels before publication without changing the original', async () => {
      f.put('file', bytes('keep'))
      const stream = new ReadableStream<Uint8Array>()
      const signal = new AbortController()
      const writing = f.volume().write('file', stream, signal.signal).catch(error => error)
      await new Promise(resolve => setImmediate(resolve))
      signal.abort()
      expect(await writing).toMatchObject({ status: 409 })
      expect(f.bytes('file')).toEqual(bytes('keep'))
    })

    it('refuses an already cancelled upload without sending content', async () => {
      const signal = new AbortController()
      signal.abort()
      await expect(f.volume().write('file', body('x'), signal.signal)).rejects.toMatchObject({ status: 409 })
      expect(f.count('content')).toBe(0)
    })

    it('protects an overwrite committed just as the client cancels', async () => {
      f.put('file', bytes('before'))
      const signal = new AbortController()
      f.beforeCommit(() => signal.abort())
      await expect(f.volume().write('file', body('committed'), signal.signal)).rejects.toMatchObject({ status: 409 })
      await expect(f.volume().delete('file')).rejects.toMatchObject({ status: 409 })
      expect(f.bytes('file')).toEqual(bytes('committed'))
    })

    it('deletes a file after uploads the client cancelled and replaced', async () => {
      f.put('file', bytes('before'))
      const cancel = async (overlap?: () => Promise<void>) => {
        const signal = new AbortController()
        const writing = f.volume().write('file', new ReadableStream<Uint8Array>(), signal.signal).catch(error => error)
        await new Promise(resolve => setImmediate(resolve))
        await overlap?.()
        signal.abort()
        await writing
      }
      await cancel()
      await cancel(() => f.volume().write('file', body('final'), new AbortController().signal))
      await f.volume().delete('file')
      expect(f.exists('file')).toBe(false)
      f.put('file', bytes('again'))
      await cancel(() => cancel())
      await expect(f.volume().delete('file')).rejects.toMatchObject({ status: 409 })
      await f.volume().delete('file')
      expect(f.exists('file')).toBe(false)
    })

    it('allows mutations while another upload is waiting for its body', async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
      const writing = f.volume().write('slow', stream)
      await new Promise(resolve => setImmediate(resolve))
      await f.volume().mkdir('other')
      expect(f.exists('other')).toBe(true)
      controller.enqueue(bytes('x')); controller.close()
      await writing
    })

    it('publishes only one of two simultaneous creates of the same name', async () => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = []
      const writes = Promise.allSettled(['first', 'second'].map(() => f.volume().write('same', new ReadableStream({ start(c) { controllers.push(c) } }))))
      await new Promise(resolve => setImmediate(resolve))
      controllers.forEach((c, i) => { c.enqueue(bytes(String(i))); c.close() })
      expect((await writes).map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(f.bytes('same')?.length).toBe(1)
    })

    it('rechecks account revocation before publishing a staged upload', async () => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const writing = f.volume().write('file', new ReadableStream({ start(c) { controller = c } })).catch(error => error)
      await new Promise(resolve => setImmediate(resolve))
      f.revoke()
      controller.enqueue(bytes('x')); controller.close()
      expect(await writing).toMatchObject({ code: 'not-accessible' })
      expect(f.count('content')).toBe(0)
      expect(f.exists('file')).toBe(false)
    })

    it('removes only its own new file when cancellation arrives during publication', async () => {
      const signal = new AbortController()
      f.beforeCommit(() => signal.abort())
      await f.volume().write('new', body('new'), signal.signal).catch(() => {})
      expect(f.exists('new')).toBe(false)
    })

    it('refuses overwriting an external edit made while the upload body arrives', async () => {
      f.put('file', bytes('initial'))
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
      const writing = f.volume().write('file', stream).catch(error => error)
      await new Promise(resolve => setImmediate(resolve))
      f.put('file', bytes('external edit'))
      controller.enqueue(bytes('stale edit')); controller.close()
      expect(await writing).toBeInstanceOf(Error)
      expect(f.bytes('file')).toEqual(bytes('external edit'))
    })

    it('retains unrelated cached folders when another folder changes', async () => {
      f.mkdir('a'); f.mkdir('b')
      await f.volume().list('b')
      const count = f.count('list', 'b')
      await f.volume().write('a/file', body('x'))
      await f.volume().list('b')
      expect(f.count('list', 'b')).toBe(count)
    })

    it('expires healthy advisory checks after one minute', async () => {
      await f.volume().health()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 59_000)
      try {
        await f.volume().health()
        expect(f.count('health')).toBe(1)
        clock.mockReturnValue(Date.now() + 1_001)
        await f.volume().health()
        expect(f.count('health')).toBe(2)
      } finally { clock.mockRestore() }
    })

    it('coalesces advisory health checks but rechecks account authorization', async () => {
      await Promise.all([f.volume().health(), f.volume().health(), f.volume().health()])
      expect(f.count('health')).toBe(1)
      f.revoke()
      await expect(f.volume().health()).rejects.toMatchObject({ code: 'not-accessible' })
    })
  })
}
