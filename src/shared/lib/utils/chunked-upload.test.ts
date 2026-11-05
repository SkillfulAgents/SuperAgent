import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import os from 'os'
import path from 'path'
import { appState, closeAppState, digestKeyPart } from '@shared/lib/app-state'
import {
  MAX_UPLOAD_TOTAL_SIZE,
  UPLOAD_FINALIZER_LEASE_MS,
  UPLOAD_IDLE_EXPIRY_MS,
  UPLOAD_RESERVATION_MS,
  UPLOAD_RESULT_RETENTION_MS,
  UploadConflictError,
  UploadTooLargeError,
  cleanupStaleTempUploads,
  formatUploadTooLargeMessage,
  storeUploadChunk,
  uploadManifestKey,
  type AssembledUpload,
  type StoreChunkInput,
  type UploadResponse,
} from './chunked-upload'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'
import { localDiskUploadByteStore, setUploadByteStore, type UploadByteStore } from './chunked-upload-bytes'
import { uploadManifestSchema, type UploadManifest } from './chunked-upload-schema'

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

const tmpRoot = path.join(os.tmpdir(), `chunked-upload-${process.pid}-${Date.now()}`)
const tempUploadsDir = path.join(tmpRoot, 'tmp', 'uploads')

vi.mock('./file-storage', async () => {
  const actual = await vi.importActual<typeof import('./file-storage')>('./file-storage')
  return {
    ...actual,
    getTempUploadsDir: () => tempUploadsDir,
  }
})

const T0 = Date.parse('2026-11-04T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const OWNER = 'user-1'
const UPLOAD_ID = '11111111-1111-1111-1111-111111111111'
const CAP = 1_000

/** A store in memory: a test stand-in for a store other than disk, none of which ships yet. */
function memoryByteStore(): UploadByteStore {
  const blobs = new Map<string, Uint8Array>()
  return {
    put: async (key, bytes) => {
      blobs.set(key, new Uint8Array(bytes))
    },
    delete: async (key) => {
      blobs.delete(key)
    },
    list: async (prefix) => [...blobs]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, bytes]) => ({ key, size: bytes.byteLength })),
    stream: async (key) => {
      const bytes = blobs.get(key)
      return bytes ? (new Blob([new Uint8Array(bytes)]).stream() as ReadableStream<Uint8Array>) : null
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function chunk(chunkIndex: number, totalChunks: number, data: string, overrides: Partial<StoreChunkInput> = {}): StoreChunkInput {
  return {
    ownerId: OWNER,
    uploadId: UPLOAD_ID,
    target: 'agent:a',
    chunkIndex,
    totalChunks,
    chunk: Buffer.from(data),
    maxTotalBytes: CAP,
    ...overrides,
  }
}

const readAll = (stream: ReadableStream<Uint8Array>) => new Response(stream).text()

/** The usual `finish`: answers with what the upload's stream holds. */
function finishReading() {
  return vi.fn(async (assembled: AssembledUpload): Promise<UploadResponse> => ({
    status: 200,
    body: { content: await readAll(assembled.stream()) },
  }))
}

/** A `finish` that has read the upload and then waits for the test. */
function finishGated() {
  const entered = deferred<AssembledUpload>()
  const gate = deferred()
  const finish = vi.fn(async (assembled: AssembledUpload): Promise<UploadResponse> => {
    const content = await readAll(assembled.stream())
    entered.resolve(assembled)
    await gate.promise
    return { status: 200, body: { content, by: finish.mock.calls.length } }
  })
  return { finish, entered, gate }
}

const neverFinishes = () => vi.fn(async (): Promise<UploadResponse> => {
  throw new Error('finish should not have run')
})

async function manifest(ownerId = OWNER, uploadId = UPLOAD_ID): Promise<UploadManifest | undefined> {
  return (await appState().get(uploadManifestKey(ownerId, uploadId)))?.value
}

/** The next write of a manifest that `matches` lands in the backend, and its answer is lost. */
function loseAnswerOfWrite(matches: (value: UploadManifest) => boolean) {
  const state = appState()
  const compareAndSet = state.compareAndSet.bind(state)
  let lost = false
  vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
    const answer = await compareAndSet(key, expected, value, options)
    if (!lost && answer.ok && key.path.startsWith('upload/') && matches(value as UploadManifest)) {
      lost = true
      throw new Error('connection lost')
    }
    return answer
  })
  return () => lost
}

/** Holds the next `count` writes of a holder's own name before they reach the backend. */
function holdNamings(count: number) {
  const state = appState()
  const compareAndSet = state.compareAndSet.bind(state)
  const holds = Array.from({ length: count }, () => ({ reached: deferred(), gate: deferred() }))
  let next = 0
  vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
    const written = value as UploadManifest
    if (next < count && key.path.startsWith('upload/') && written.state === 'finalizing' && written.finalizer !== null) {
      const hold = holds[next++]!
      hold.reached.resolve()
      await hold.gate.promise
    }
    return compareAndSet(key, expected, value, options)
  })
  return holds
}

/** Holds the `nth` read of the manifest after the next lease is acquired, before it reaches the backend. */
function holdManifestReadUnderLease(nth: number) {
  const state = appState()
  const insertIfAbsent = state.insertIfAbsent.bind(state)
  const get = state.get.bind(state)
  const reached = deferred()
  const gate = deferred()
  let reads = -1
  vi.spyOn(state, 'insertIfAbsent').mockImplementation(async (key, value, options) => {
    const answer = await insertIfAbsent(key, value, options)
    if (reads === -1 && key.path.startsWith('claim:upload-finalize/') && answer.inserted) reads = 0
    return answer
  })
  vi.spyOn(state, 'get').mockImplementation((async (key: never) => {
    if (reads >= 0 && reads < nth && (key as { path: string }).path.startsWith('upload/') && ++reads === nth) {
      reached.resolve()
      await gate.promise
    }
    return get(key)
  }) as typeof state.get)
  return { reached, gate }
}

/** Holds the next request for the finalizer's lease before it reaches the backend. */
function holdNextLeaseRequest() {
  const state = appState()
  const insertIfAbsent = state.insertIfAbsent.bind(state)
  const reached = deferred()
  const gate = deferred()
  let held = false
  vi.spyOn(state, 'insertIfAbsent').mockImplementation(async (key, value, options) => {
    if (!held && key.path.startsWith('claim:upload-finalize/')) {
      held = true
      reached.resolve()
      await gate.promise
    }
    return insertIfAbsent(key, value, options)
  })
  return { reached, gate }
}

/** How many times the finalizer's lease was renewed since `compareAndSet` was spied on. */
function leaseRenewals(): number {
  return vi.mocked(appState().compareAndSet).mock.calls.filter(([key]) => key.path.startsWith('claim:upload-finalize/')).length
}

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms)

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 })
  await fs.promises.mkdir(tempUploadsDir, { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  setUploadByteStore(null)
  await fs.promises.rm(tmpRoot, { recursive: true, force: true })
})

describe.each<[string, () => UploadByteStore]>([
  ['the local disk', () => ({ ...localDiskUploadByteStore })],
  ['an in-memory stand-in', memoryByteStore],
])('chunked uploads over %s', (_name, createStore) => {
  let store: UploadByteStore

  beforeEach(() => {
    store = createStore()
    setUploadByteStore(store)
  })

  const storedKeys = async () => (await store.list('uploads/')).map(({ key }) => key)

  /** Holds each `put` after its bytes are stored, until `count` of them have been. */
  function holdPutsUntil(count: number) {
    const all = deferred()
    const put = store.put.bind(store)
    let stored = 0
    vi.spyOn(store, 'put').mockImplementation(async (key, bytes) => {
      await put(key, bytes)
      if (++stored >= count) all.resolve()
      await all.promise
    })
  }

  /** Holds the next `put` after its bytes are stored, until the test lets it go. */
  function holdNextPut() {
    const stored = deferred()
    const gate = deferred()
    const put = store.put.bind(store)
    vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
      await put(key, bytes)
      stored.resolve()
      await gate.promise
    })
    return { stored, gate }
  }

  describe('storing chunks', () => {
    it('answers received until every chunk has arrived, then hands over the upload and removes its bytes', async () => {
      const finish = finishReading()
      await expect(storeUploadChunk(chunk(1, 3, 'bb'), finish)).resolves.toEqual({ status: 'received' })
      await expect(storeUploadChunk(chunk(0, 3, 'aa'), finish)).resolves.toEqual({ status: 'received' })
      expect(finish).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)

      const result = await storeUploadChunk(chunk(2, 3, 'cc'), finish)

      expect(result).toEqual({ status: 'finished', response: { status: 200, body: { content: 'aabbcc' } } })
      expect(finish).toHaveBeenCalledOnce()
      expect(finish.mock.calls[0]![0].size).toBe(6)
      expect(await storedKeys()).toEqual([])
      expect((await manifest())?.state).toBe('completed')
    })

    it('finishes an upload of one chunk on that chunk', async () => {
      const finish = finishReading()
      await expect(storeUploadChunk(chunk(0, 1, 'only'), finish)).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'only' } } })
    })

    it('treats an id in another case as the same upload', async () => {
      await storeUploadChunk(chunk(0, 2, 'a', { uploadId: 'ABCDEF00-1111-1111-1111-111111111111' }), neverFinishes())
      const result = await storeUploadChunk(chunk(1, 2, 'b', { uploadId: 'abcdef00-1111-1111-1111-111111111111' }), finishReading())
      expect(result).toMatchObject({ response: { body: { content: 'ab' } } })
    })

    it('keeps two owners using one upload id apart, in the manifest and in the bytes', async () => {
      const finish = finishReading()
      await storeUploadChunk(chunk(0, 2, 'mine', { ownerId: 'user-1' }), finish)
      // Another owner may even disagree on the upload's shape.
      await storeUploadChunk(chunk(0, 3, 'them', { ownerId: 'user-2' }), finish)

      const keys = await storedKeys()
      expect(keys).toHaveLength(2)
      expect(keys.filter((key) => key.startsWith(`uploads/${digestKeyPart('user-1')}/${UPLOAD_ID}/`))).toHaveLength(1)
      expect(keys.filter((key) => key.startsWith(`uploads/${digestKeyPart('user-2')}/${UPLOAD_ID}/`))).toHaveLength(1)

      const result = await storeUploadChunk(chunk(1, 2, '-1', { ownerId: 'user-1' }), finish)
      expect(result).toMatchObject({ response: { body: { content: 'mine-1' } } })
      expect((await manifest('user-2'))?.state).toBe('receiving')
      expect(await storedKeys()).toHaveLength(1)
    })
  })

  describe('reading the upload', () => {
    const decoder = new TextDecoder()

    /** Reads to the end, and says what it saw: the text so far, whether it closed, and the error if it did not. */
    async function drain(stream: ReadableStream<Uint8Array>) {
      const reader = stream.getReader()
      let text = ''
      for (;;) {
        try {
          const { done, value } = await reader.read()
          if (done) return { text, closed: true, error: null }
          text += decoder.decode(value)
        } catch (error) {
          return { text, closed: false, error }
        }
      }
    }

    it('reads the chunks in order, opening each only when the one before it has been read', async () => {
      await storeUploadChunk(chunk(1, 3, 'bb'), neverFinishes())
      await storeUploadChunk(chunk(0, 3, 'aa'), neverFinishes())
      const opened = vi.spyOn(store, 'stream')
      const seen: { text: string; opened: number; openedAfterAWhile: number }[] = []
      let openedByTheStreamAlone = -1

      await storeUploadChunk(chunk(2, 3, 'cc'), async ({ stream, size }) => {
        expect(size).toBe(6)
        const reader = stream().getReader()
        await new Promise((resolve) => setImmediate(resolve))
        openedByTheStreamAlone = opened.mock.calls.length
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return { status: 200, body: {} }
          const openedNow = opened.mock.calls.length
          // Time to read ahead, for a stream that would.
          await new Promise((resolve) => setImmediate(resolve))
          seen.push({ text: decoder.decode(value), opened: openedNow, openedAfterAWhile: opened.mock.calls.length })
        }
      })

      expect(openedByTheStreamAlone).toBe(0)
      expect(seen).toEqual([
        { text: 'aa', opened: 1, openedAfterAWhile: 1 },
        { text: 'bb', opened: 2, openedAfterAWhile: 2 },
        { text: 'cc', opened: 3, openedAfterAWhile: 3 },
      ])
    })

    it('never reads a chunk whole into memory from the disk', async () => {
      await storeUploadChunk(chunk(0, 2, 'hello '), neverFinishes())
      const readFile = vi.spyOn(fs.promises, 'readFile')
      const result = await storeUploadChunk(chunk(1, 2, 'world'), finishReading())
      expect(readFile).not.toHaveBeenCalled()
      expect(result).toMatchObject({ response: { body: { content: 'hello world' } } })
    })

    it('writes no file when only the stream is used', async () => {
      const assembledDir = path.join(tempUploadsDir, 'assembled')
      let duringFinish = true
      await storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
        await readAll(stream())
        duringFinish = fs.existsSync(assembledDir)
        return { status: 200, body: {} }
      })
      expect(duringFinish).toBe(false)
      expect(fs.existsSync(assembledDir)).toBe(false)
    })

    it('writes a file only when asked, once, and removes it after `finish`', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const opened = vi.spyOn(store, 'stream')
      let filePath = ''
      await storeUploadChunk(chunk(1, 2, 'bb'), async ({ toFile }) => {
        filePath = await toFile()
        expect(await toFile()).toBe(filePath)
        expect(await fs.promises.readFile(filePath, 'utf8')).toBe('aabb')
        return { status: 200, body: {} }
      })
      expect(opened).toHaveBeenCalledTimes(2)
      expect(path.dirname(filePath)).toBe(path.join(tempUploadsDir, 'assembled'))
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('removes the file when `finish` throws, and the upload stays for a retry', async () => {
      let filePath = ''
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async ({ toFile }) => {
        filePath = await toFile()
        throw new Error('work failed')
      })).rejects.toThrow('work failed')
      expect(fs.existsSync(filePath)).toBe(false)
      expect((await manifest())?.state).toBe('finalizing')
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'a' } } })
    })

    it('leaves a file the consumer moved alone', async () => {
      const moved = path.join(tmpRoot, 'moved')
      const result = await storeUploadChunk(chunk(0, 1, 'x'), async ({ toFile }) => {
        await fs.promises.rename(await toFile(), moved)
        return { status: 200, body: {} }
      })
      expect(result.status).toBe('finished')
      expect(await fs.promises.readFile(moved, 'utf8')).toBe('x')
    })

    describe.each<[string, number, string]>([
      ['the first chunk', 0, ''],
      ['the last chunk', 1, 'aa'],
    ])('with %s broken', (_where, broken, before) => {
      const unreadable = () => new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('store went away'))
        },
      })
      const halfThenUnreadable = () => {
        let sent = false
        return new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.error(new Error('store went away'))
            else controller.enqueue(new TextEncoder().encode('x'))
            sent = true
          },
        })
      }

      it.each<[string, () => ReadableStream<Uint8Array> | null, string, string]>([
        ['shorter than its manifest size', () => new Blob(['x']).stream() as ReadableStream<Uint8Array>, 'its manifest says 2', 'x'],
        ['empty', () => new Blob([]).stream() as ReadableStream<Uint8Array>, 'its manifest says 2', ''],
        ['longer than its manifest size', () => new Blob(['xxx']).stream() as ReadableStream<Uint8Array>, 'over the 2 bytes', ''],
        ['missing', () => null, 'is missing', ''],
        ['unreadable from the start', unreadable, 'store went away', ''],
        ['unreadable partway', halfThenUnreadable, 'store went away', 'x'],
      ])('errors the stream when the chunk is %s, and a retry can run it', async (_how, source, message, partial) => {
        await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
        const realStream = store.stream.bind(store)
        let calls = 0
        const opened = vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === broken ? source() : realStream(key)))
        let drained: Awaited<ReturnType<typeof drain>> | null = null

        await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
          drained = await drain(stream())
          if (drained.error) throw drained.error
          return { status: 200, body: { took: 'it for the whole upload' } }
        })).rejects.toThrow(message)

        expect(drained!.closed).toBe(false)
        expect(drained!.text).toBe(before + partial)
        expect(String(drained!.error)).toContain(message)
        // Reading stopped there.
        expect(calls).toBe(broken + 1)
        expect(await manifest()).toMatchObject({ state: 'finalizing' })
        expect(await storedKeys()).toHaveLength(2)

        opened.mockRestore()
        await expect(storeUploadChunk(chunk(1, 2, 'bb'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'aabb' } } })
      })

      it('errors the stream when the store cannot open the chunk', async () => {
        await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
        const realStream = store.stream.bind(store)
        let calls = 0
        vi.spyOn(store, 'stream').mockImplementation(async (key) => {
          if (calls++ === broken) throw new Error('store unavailable')
          return realStream(key)
        })
        const finish = finishReading()
        await expect(storeUploadChunk(chunk(1, 2, 'bb'), finish)).rejects.toThrow('store unavailable')
        expect(await manifest()).toMatchObject({ state: 'finalizing' })
      })
    })

    it('errors the stream when a chunk really has gone from the store', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await store.delete((await storedKeys())[0]!)
      await expect(storeUploadChunk(chunk(1, 2, 'b'), finishReading())).rejects.toThrow('Upload chunk 0 is missing')
      expect(await manifest()).toMatchObject({ state: 'finalizing' })
    })

    it('errors `toFile` as well, and removes the part it wrote', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const realStream = store.stream.bind(store)
      let calls = 0
      vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === 1 ? new Blob(['x']).stream() as ReadableStream<Uint8Array> : realStream(key)))

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ toFile }) => {
        await toFile()
        return { status: 200, body: {} }
      })).rejects.toThrow('its manifest says 2')

      expect(await fs.promises.readdir(path.join(tempUploadsDir, 'assembled'))).toEqual([])
      expect(await manifest()).toMatchObject({ state: 'finalizing' })
    })

    it('keeps no answer when `finish` makes one of a failed read, as the routes do', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const realStream = store.stream.bind(store)
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => null).mockImplementation(realStream)

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
        await readAll(stream()).catch(() => undefined)
        return { status: 500, body: { error: 'Failed to upload file' } }
      })).rejects.toThrow('Upload chunk 0 is missing')

      expect(await manifest()).toMatchObject({ state: 'finalizing' })
      expect(await storedKeys()).toHaveLength(2)
      await expect(storeUploadChunk(chunk(1, 2, 'bb'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'aabb' } } })
    })

    it('keeps no answer when `finish` makes one of a file it could not write', async () => {
      await fs.promises.writeFile(path.join(tempUploadsDir, 'assembled'), 'in the way')

      await expect(storeUploadChunk(chunk(0, 1, 'a'), async ({ toFile }) => {
        await toFile().catch(() => undefined)
        return { status: 500, body: { error: 'Failed' } }
      })).rejects.toThrow()

      expect(await manifest()).toMatchObject({ state: 'finalizing' })
      await fs.promises.rm(path.join(tempUploadsDir, 'assembled'))
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).resolves.toMatchObject({ status: 'finished' })
    })

    it('keeps the answer of a consumer that gave up by itself, and closes what it was reading', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const cancelled = vi.fn()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('a'))
        },
        cancel: cancelled,
      }))
      const response = { status: 500, body: { error: 'The destination refused it' } }

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
        const reader = stream().getReader()
        await reader.read()
        await reader.cancel(new Error('the destination refused it'))
        return response
      })).resolves.toEqual({ status: 'finished', response })

      expect(cancelled).toHaveBeenCalledOnce()
      await expect(storeUploadChunk(chunk(1, 2, 'bb'), neverFinishes())).resolves.toEqual({ status: 'finished', response })
    })

    it('keeps the answer of a consumer that gave up while a read was waiting', async () => {
      const cancelled = vi.fn()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({ cancel: cancelled }))
      const response = { status: 500, body: { error: 'The destination refused it' } }

      await expect(storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
        const reader = stream().getReader()
        const waiting = reader.read()
        // Let it open the chunk it will wait on.
        await new Promise((resolve) => setImmediate(resolve))
        await reader.cancel()
        await waiting
        // The wait ends short of the chunk's size, which is no failure now.
        await new Promise((resolve) => setImmediate(resolve))
        return response
      })).resolves.toEqual({ status: 'finished', response })

      expect(cancelled).toHaveBeenCalledOnce()
    })

    it('closes a chunk that opens after the consumer gave up', async () => {
      await storeUploadChunk(chunk(0, 1, 'a'), async () => {
        throw new Error('first try fails')
      }).catch(() => undefined)
      const opening = deferred()
      const opens = deferred<ReadableStream<Uint8Array>>()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => {
        opening.resolve()
        return opens.promise
      })
      const cancelled = vi.fn()

      await storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
        const reader = stream().getReader()
        const pending = reader.read()
        await opening.promise
        await reader.cancel()
        await pending
        opens.resolve(new ReadableStream<Uint8Array>({ cancel: cancelled }))
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce())
        return { status: 200, body: {} }
      })
    })

    it('fails the write of a consumer writing from the stream, leaves nothing at the destination, and a retry can run it', async () => {
      const workspace = path.join(tmpRoot, 'workspace')
      const files = new LocalFileOps(() => workspace)
      await fs.promises.mkdir(path.join(workspace, 'uploads'), { recursive: true })
      const write = async ({ stream }: AssembledUpload): Promise<UploadResponse> => {
        const { size } = await files.write('uploads/report.bin', stream())
        return { status: 200, body: { size } }
      }
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const realStream = store.stream.bind(store)
      let calls = 0
      const opened = vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === 1 ? new Blob(['b']).stream() as ReadableStream<Uint8Array> : realStream(key)))

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), write)).rejects.toThrow('its manifest says 2')

      expect(await fs.promises.readdir(path.join(workspace, 'uploads'))).toEqual([])
      expect(await manifest()).toMatchObject({ state: 'finalizing' })

      opened.mockRestore()
      await expect(storeUploadChunk(chunk(1, 2, 'bb'), write)).resolves.toMatchObject({ response: { body: { size: 4 } } })
      expect(await fs.promises.readFile(path.join(workspace, 'uploads', 'report.bin'), 'utf8')).toBe('aabb')
    })

    it('keeps what was at the destination when the stream errors', async () => {
      const workspace = path.join(tmpRoot, 'workspace')
      const files = new LocalFileOps(() => workspace)
      await fs.promises.mkdir(path.join(workspace, 'uploads'), { recursive: true })
      await fs.promises.writeFile(path.join(workspace, 'uploads', 'report.bin'), 'older')
      vi.spyOn(store, 'stream').mockResolvedValueOnce(new Blob(['aaaa']).stream() as ReadableStream<Uint8Array>)

      await expect(storeUploadChunk(chunk(0, 1, 'aa'), async ({ stream }) => {
        await files.write('uploads/report.bin', stream())
        return { status: 200, body: {} }
      })).rejects.toThrow('over the 2 bytes')

      expect(await fs.promises.readFile(path.join(workspace, 'uploads', 'report.bin'), 'utf8')).toBe('older')
      expect(await fs.promises.readdir(path.join(workspace, 'uploads'))).toEqual(['report.bin'])
    })

    it('lets a stale holder read on beside its successor, whose answer stands when the chunks go', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const firstRead = deferred()
      const goOn = deferred()
      const staleFinish = async ({ stream }: AssembledUpload): Promise<UploadResponse> => {
        const reader = stream().getReader()
        await reader.read()
        firstRead.resolve()
        await goOn.promise
        for (;;) {
          const { done } = await reader.read()
          if (done) return { status: 200, body: { by: 'stale' } }
        }
      }
      const stale = storeUploadChunk(chunk(1, 2, 'bb'), staleFinish)
      await firstRead.promise

      advance(UPLOAD_FINALIZER_LEASE_MS)
      const answer = await storeUploadChunk(chunk(1, 2, 'bb'), finishReading())
      expect(answer).toMatchObject({ response: { body: { content: 'aabb' } } })

      // Its successor kept its answer and removed the chunks, so the stale holder cannot finish reading.
      goOn.resolve()
      await expect(stale).rejects.toThrow('Upload chunk 1 is missing')
      await expect(storeUploadChunk(chunk(1, 2, 'bb'), neverFinishes())).resolves.toEqual(answer)
    })
  })

  describe('simultaneous last chunks', () => {
    it('lets exactly one of two different last chunks claim the assembly', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      // Both have reserved and written before either commits.
      holdPutsUntil(2)
      const finish = finishReading()

      const results = await Promise.all([
        storeUploadChunk(chunk(1, 3, 'b'), finish),
        storeUploadChunk(chunk(2, 3, 'c'), finish),
      ])

      expect(results.map(({ status }) => status).sort()).toEqual(['finished', 'received'])
      expect(finish).toHaveBeenCalledOnce()
      expect(results.find(({ status }) => status === 'finished')).toMatchObject({ response: { body: { content: 'abc' } } })
    })

    it('finishes once when every chunk arrives at once', async () => {
      const total = 40
      const finish = finishReading()
      const results = await Promise.all(Array.from({ length: total }, (_, i) => storeUploadChunk(chunk(i, total, String.fromCharCode(48 + i)), finish)))

      expect(results.filter(({ status }) => status === 'finished')).toHaveLength(1)
      expect(results.filter(({ status }) => status === 'received')).toHaveLength(total - 1)
      expect(finish).toHaveBeenCalledOnce()
      expect(results.find(({ status }) => status === 'finished')).toMatchObject({
        response: { body: { content: Array.from({ length: total }, (_, i) => String.fromCharCode(48 + i)).join('') } },
      })
    })

    it('finishes once when the same last chunk arrives several times at once', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      holdPutsUntil(3)
      const finish = finishReading()

      const results = await Promise.all([
        storeUploadChunk(chunk(1, 2, 'b'), finish),
        storeUploadChunk(chunk(1, 2, 'b'), finish),
        storeUploadChunk(chunk(1, 2, 'b'), finish),
      ])

      expect(finish).toHaveBeenCalledOnce()
      expect(results.filter(({ status }) => status === 'received')).toHaveLength(0)
      expect(results.filter(({ status }) => status === 'finished').length).toBeGreaterThanOrEqual(1)
      expect(await storedKeys()).toEqual([])
    })

    it('finishes once when the last chunks reach two processes', async () => {
      vi.resetModules()
      const otherBytes = await import('./chunked-upload-bytes')
      otherBytes.setUploadByteStore(store)
      const otherProcess = await import('./chunked-upload')
      expect(otherProcess.storeUploadChunk).not.toBe(storeUploadChunk)

      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      holdPutsUntil(2)
      const finish = finishReading()

      const results = await Promise.all([
        storeUploadChunk(chunk(1, 3, 'b'), finish),
        otherProcess.storeUploadChunk(chunk(2, 3, 'c'), finish),
      ])

      expect(results.map(({ status }) => status).sort()).toEqual(['finished', 'received'])
      expect(finish).toHaveBeenCalledOnce()
    })
  })

  describe('retries and conflicts', () => {
    it('stores nothing for a chunk it already has, and counts it once', async () => {
      await storeUploadChunk(chunk(0, 2, 'aaaaaa', { maxTotalBytes: 10 }), neverFinishes())
      const put = vi.spyOn(store, 'put')

      for (let i = 0; i < 3; i++) {
        await expect(storeUploadChunk(chunk(0, 2, 'aaaaaa', { maxTotalBytes: 10 }), neverFinishes())).resolves.toEqual({ status: 'received' })
      }

      expect(put).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(1)
    })

    it('replaces a chunk with different bytes, moving its accounting and removing the old bytes', async () => {
      await storeUploadChunk(chunk(0, 2, 'aaaaaaaa', { maxTotalBytes: 10 }), neverFinishes())
      const before = await storedKeys()

      // 8 + 9 would not fit; the replacement takes the first one's place.
      await expect(storeUploadChunk(chunk(0, 2, 'bbbbbbbbb', { maxTotalBytes: 10 }), neverFinishes())).resolves.toEqual({ status: 'received' })

      const after = await storedKeys()
      expect(after).toHaveLength(1)
      expect(after).not.toEqual(before)
      const result = await storeUploadChunk(chunk(1, 2, 'c', { maxTotalBytes: 10 }), finishReading())
      expect(result).toMatchObject({ response: { body: { content: 'bbbbbbbbbc' } } })
    })

    it.each<[string, Partial<StoreChunkInput>]>([
      ['chunk count', { totalChunks: 3 }],
      ['target', { target: 'agent:b' }],
      ['size limit', { maxTotalBytes: CAP + 1 }],
    ])('refuses a later chunk that disagrees on the %s, and stores nothing', async (_what, overrides) => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const before = await manifest()
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 2, 'b', overrides), neverFinishes())).rejects.toBeInstanceOf(UploadConflictError)

      expect(put).not.toHaveBeenCalled()
      expect(await manifest()).toEqual(before)
    })

    it('answers a retry while the upload is finishing without running it again, and refuses different bytes', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const { finish, entered, gate } = finishGated()
      const running = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await entered.promise
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 2, 'b'), neverFinishes())).resolves.toEqual({ status: 'finalizing' })
      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).resolves.toEqual({ status: 'finalizing' })
      await expect(storeUploadChunk(chunk(1, 2, 'different'), neverFinishes())).rejects.toBeInstanceOf(UploadConflictError)
      expect(put).not.toHaveBeenCalled()

      gate.resolve()
      await expect(running).resolves.toMatchObject({ status: 'finished' })
    })

    it('answers a retry after the upload ended with the kept answer, for as long as it is kept', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const first = await storeUploadChunk(chunk(1, 2, 'b'), finishReading())
      const again = neverFinishes()

      await expect(storeUploadChunk(chunk(1, 2, 'b'), again)).resolves.toEqual(first)
      await expect(storeUploadChunk(chunk(0, 2, 'a'), again)).resolves.toEqual(first)
      await expect(storeUploadChunk(chunk(1, 2, 'different'), again)).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toEqual([])

      advance(UPLOAD_RESULT_RETENTION_MS - 1)
      await expect(storeUploadChunk(chunk(1, 2, 'b'), again)).resolves.toEqual(first)
      advance(1)
      // Gone: a new upload of one chunk, which runs nothing by itself.
      await expect(storeUploadChunk(chunk(1, 2, 'b'), again)).resolves.toEqual({ status: 'received' })
      expect(again).not.toHaveBeenCalled()
    })

    it('keeps a failed end too, so a retry does not run it again', async () => {
      const response = { status: 500, body: { error: 'not a template' } }
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async () => response)).resolves.toEqual({ status: 'finished', response })
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual({ status: 'finished', response })
      expect(await storedKeys()).toEqual([])
    })

    it('tells a retry the upload finished when its answer was too large to keep', async () => {
      const response = { status: 200, body: { text: 'x'.repeat(70 * 1024) } }
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async () => response)).resolves.toEqual({ status: 'finished', response })
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).rejects.toBeInstanceOf(UploadConflictError)
    })

    it('rejects a write landing after finalization started, and removes its bytes', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const late = holdNextPut()
      const replacement = storeUploadChunk(chunk(0, 2, 'late'), neverFinishes())
      await late.stored.promise

      const { finish, entered, gate } = finishGated()
      const running = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await entered.promise
      expect(await storedKeys()).toHaveLength(3)

      late.gate.resolve()
      await expect(replacement).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toHaveLength(2)

      gate.resolve()
      await expect(running).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
      expect(await storedKeys()).toEqual([])
    })

    it('rejects a write landing after the upload ended, and removes its bytes', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const late = holdNextPut()
      const replacement = storeUploadChunk(chunk(0, 2, 'late'), neverFinishes())
      await late.stored.promise
      await storeUploadChunk(chunk(1, 2, 'b'), finishReading())

      late.gate.resolve()
      await expect(replacement).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toEqual([])
    })

    it('removes a late write whose manifest expired meanwhile, and does not bring the manifest back', async () => {
      const late = holdNextPut()
      const write = storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await late.stored.promise
      advance(UPLOAD_IDLE_EXPIRY_MS)
      expect(await manifest()).toBeUndefined()

      late.gate.resolve()
      await expect(write).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toEqual([])
      expect(await manifest()).toBeUndefined()
    })

    it('refuses a commit whose reservation ran out and was dropped, and gives its room back', async () => {
      const slow = holdNextPut()
      const write = storeUploadChunk(chunk(0, 3, 'aaaaaaaa', { maxTotalBytes: 10 }), neverFinishes())
      await slow.stored.promise
      advance(UPLOAD_RESERVATION_MS)

      // Would not fit next to a live reservation of 8. The next write drops it.
      await expect(storeUploadChunk(chunk(1, 3, 'bbbbbbbb', { maxTotalBytes: 10 }), neverFinishes())).resolves.toEqual({ status: 'received' })

      slow.gate.resolve()
      await expect(write).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toHaveLength(1)
    })

    it('refuses more writes in flight than an upload may have, without storing them', async () => {
      const inFlight = deferred()
      const put = store.put.bind(store)
      const writes: Promise<unknown>[] = []
      vi.spyOn(store, 'put').mockImplementation(async (key, bytes) => {
        await inFlight.promise
        await put(key, bytes)
      })
      for (let i = 0; i < 64; i++) writes.push(storeUploadChunk(chunk(i, 100, 'x'), neverFinishes()))
      await vi.waitFor(async () => {
        const stored = await manifest()
        expect(stored?.state === 'receiving' && Object.keys(stored.reservations).length).toBe(64)
      })

      await expect(storeUploadChunk(chunk(64, 100, 'x'), neverFinishes())).rejects.toBeInstanceOf(UploadConflictError)

      inFlight.resolve()
      await Promise.all(writes)
    })
  })

  describe('failed writes', () => {
    it('gives the reservation back and removes what the write left, so the retry succeeds', async () => {
      const put = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
        await put(key, bytes.subarray(0, 1))
        throw new Error('disk full')
      })

      await expect(storeUploadChunk(chunk(0, 1, 'aaaaaaaa', { maxTotalBytes: 10 }), neverFinishes())).rejects.toThrow('disk full')

      expect(await storedKeys()).toEqual([])
      expect(await manifest()).toMatchObject({ state: 'receiving', chunks: {}, reservations: {} })

      const result = await storeUploadChunk(chunk(0, 1, 'aaaaaaaa', { maxTotalBytes: 10 }), finishReading())
      expect(result).toMatchObject({ response: { body: { content: 'aaaaaaaa' } } })
    })

    it('frees the room a failed write reserved', async () => {
      vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk full'))
      await expect(storeUploadChunk(chunk(0, 2, 'aaaaaaaa', { maxTotalBytes: 10 }), neverFinishes())).rejects.toThrow('disk full')

      // Only fits because the failed write's 8 bytes no longer count.
      await expect(storeUploadChunk(chunk(1, 2, 'bbbbbbbb', { maxTotalBytes: 10 }), neverFinishes())).resolves.toEqual({ status: 'received' })
    })

    it('cannot clobber a committed chunk', async () => {
      await storeUploadChunk(chunk(0, 2, 'good'), neverFinishes())
      const put = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
        await put(key, bytes)
        throw new Error('answer lost')
      })

      await expect(storeUploadChunk(chunk(0, 2, 'bad!'), neverFinishes())).rejects.toThrow('answer lost')

      const result = await storeUploadChunk(chunk(1, 2, '+more'), finishReading())
      expect(result).toMatchObject({ response: { body: { content: 'good+more' } } })
    })

    it('leaves bytes it could not delete to the sweep', async () => {
      const put = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
        await put(key, bytes)
        throw new Error('disk full')
      })
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('store unavailable'))

      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).rejects.toThrow('disk full')
      expect(await storedKeys()).toHaveLength(1)

      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      await cleanupStaleTempUploads(HOUR)
      expect(await storedKeys()).toEqual([])
    })
  })

  describe('the size cap', () => {
    it('refuses an upload over the cap, removes its bytes, and keeps refusing it', async () => {
      await storeUploadChunk(chunk(0, 3, '0123456789', { maxTotalBytes: 15 }), neverFinishes())
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 3, '0123456789', { maxTotalBytes: 15 }), neverFinishes())).rejects.toMatchObject({
        name: 'UploadTooLargeError', size: 20, maxBytes: 15,
      })

      expect(put).not.toHaveBeenCalled()
      expect(await storedKeys()).toEqual([])
      expect((await manifest())?.state).toBe('too_large')

      // Even a chunk that would fit: the upload as a whole did not.
      await expect(storeUploadChunk(chunk(2, 3, 'x', { maxTotalBytes: 15 }), neverFinishes())).rejects.toBeInstanceOf(UploadTooLargeError)
      expect(put).not.toHaveBeenCalled()
    })

    it('counts bytes still on their way, so chunks arriving together cannot pass it', async () => {
      const finish = neverFinishes()
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => (
        storeUploadChunk(chunk(i, 8, '0123456789', { maxTotalBytes: 35 }), finish)
      )))

      const refused = results.filter((result) => result.status === 'rejected')
      expect(refused.length).toBeGreaterThanOrEqual(5)
      for (const result of refused) expect((result as PromiseRejectedResult).reason).toBeInstanceOf(UploadTooLargeError)
      expect(finish).not.toHaveBeenCalled()
      expect((await manifest())?.state).toBe('too_large')
      expect(await storedKeys()).toEqual([])
    })

    it('refuses the second of two chunks while the first has not been written yet', async () => {
      const first = holdNextPut()
      const writing = storeUploadChunk(chunk(0, 2, '0123456789', { maxTotalBytes: 15 }), neverFinishes())
      await first.stored.promise

      await expect(storeUploadChunk(chunk(1, 2, '0123456789', { maxTotalBytes: 15 }), neverFinishes())).rejects.toBeInstanceOf(UploadTooLargeError)

      // The first's commit is refused as well, and it takes its bytes with it.
      first.gate.resolve()
      await expect(writing).rejects.toBeInstanceOf(UploadTooLargeError)
      expect(await storedKeys()).toEqual([])
    })

    it('counts an index by its largest chunk, committed or in flight', async () => {
      await storeUploadChunk(chunk(0, 2, 'aaaaaaaa', { maxTotalBytes: 10 }), neverFinishes())
      const replacement = holdNextPut()
      const writing = storeUploadChunk(chunk(0, 2, 'bbbbbbbbb', { maxTotalBytes: 10 }), neverFinishes())
      await replacement.stored.promise

      // 9 + 2: the replacement may yet land. Against the committed 8 alone it would pass.
      await expect(storeUploadChunk(chunk(1, 2, 'cc', { maxTotalBytes: 10 }), neverFinishes())).rejects.toBeInstanceOf(UploadTooLargeError)

      replacement.gate.resolve()
      await expect(writing).rejects.toBeInstanceOf(UploadTooLargeError)
    })

    it('refuses a first chunk over the cap outright', async () => {
      const put = vi.spyOn(store, 'put')
      await expect(storeUploadChunk(chunk(0, 2, '0123456789', { maxTotalBytes: 5 }), neverFinishes())).rejects.toBeInstanceOf(UploadTooLargeError)
      expect(put).not.toHaveBeenCalled()
    })

    it('accepts an upload of exactly the cap', async () => {
      await storeUploadChunk(chunk(0, 2, '01234', { maxTotalBytes: 10 }), neverFinishes())
      const result = await storeUploadChunk(chunk(1, 2, '56789', { maxTotalBytes: 10 }), finishReading())
      expect(result).toMatchObject({ status: 'finished' })
    })
  })

  describe('the finalizer', () => {
    it('hands the work to a retry once the lease lapsed, and fences the stale holder from publishing', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const stale = finishGated()
      const staleRequest = storeUploadChunk(chunk(1, 2, 'b'), stale.finish)
      await stale.entered.promise

      advance(UPLOAD_FINALIZER_LEASE_MS)
      const retried = vi.fn(async (): Promise<UploadResponse> => ({ status: 200, body: { by: 'successor' } }))
      const successor = await storeUploadChunk(chunk(1, 2, 'b'), retried)
      expect(successor).toEqual({ status: 'finished', response: { status: 200, body: { by: 'successor' } } })
      expect(retried).toHaveBeenCalledOnce()

      // The stale holder's work did happen, so its own request says so. Nothing else changes.
      stale.gate.resolve()
      await expect(staleRequest).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'ab' } } })
      await expect(storeUploadChunk(chunk(1, 2, 'b'), neverFinishes())).resolves.toEqual(successor)
      expect(await manifest()).toMatchObject({ state: 'completed', response: { body: { by: 'successor' } } })
    })

    it('leaves the chunks alone when a stale holder ends while its successor still reads them', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const stale = finishGated()
      const staleRequest = storeUploadChunk(chunk(1, 2, 'b'), stale.finish)
      await stale.entered.promise
      advance(UPLOAD_FINALIZER_LEASE_MS)

      const streamGate = deferred()
      const streamReached = deferred()
      const realStream = store.stream.bind(store)
      vi.spyOn(store, 'stream').mockImplementation(async (key) => {
        streamReached.resolve()
        await streamGate.promise
        return realStream(key)
      })
      const successor = storeUploadChunk(chunk(1, 2, 'b'), finishReading())
      await streamReached.promise

      stale.gate.resolve()
      await staleRequest
      expect(await storedKeys()).toHaveLength(2)
      expect(await manifest()).toMatchObject({ state: 'finalizing' })

      streamGate.resolve()
      await expect(successor).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'ab' } } })
      expect(await storedKeys()).toEqual([])
    })

    it('keeps the answer of a holder whose lease lapsed when nobody took over', async () => {
      const { finish, entered, gate } = finishGated()
      const request = storeUploadChunk(chunk(0, 1, 'a'), finish)
      await entered.promise
      advance(UPLOAD_FINALIZER_LEASE_MS)

      gate.resolve()
      const result = await request
      expect(result).toMatchObject({ status: 'finished' })
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual(result)
      expect(await storedKeys()).toEqual([])
    })

    it('stops before the work when the lease was lost before it, and a retry starts over', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const [write] = holdNamings(1)
      const finish = neverFinishes()
      const request = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await write!.reached.promise

      advance(UPLOAD_FINALIZER_LEASE_MS)
      write!.gate.resolve()

      await expect(request).resolves.toEqual({ status: 'finalizing' })
      expect(finish).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
    })

    it('leaves the upload for a retry when `finish` throws', async () => {
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async () => {
        throw new Error('work failed')
      })).rejects.toThrow('work failed')
      expect((await manifest())?.state).toBe('finalizing')

      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).resolves.toMatchObject({ status: 'finished' })
    })

    describe('naming itself', () => {
      const finalizerName = async () => {
        const stored = await manifest()
        return stored?.state === 'finalizing' || stored?.state === 'completed' ? stored.finalizer : undefined
      }

      /** A stale holder has backed out while its successor runs: the successor's name stands and its answer is kept. */
      async function expectSuccessorKept(successorGate: { resolve(): void }, successorRequest: Promise<unknown>, successorFinish: ReturnType<typeof vi.fn>, name: unknown) {
        expect(await finalizerName()).toBe(name)
        successorGate.resolve()
        const answer = await successorRequest
        expect(await manifest()).toMatchObject({ state: 'completed', finalizer: name })
        expect(answer).toMatchObject({ status: 'finished' })

        const retry = neverFinishes()
        await expect(storeUploadChunk(chunk(1, 2, 'b'), retry)).resolves.toEqual(answer)
        expect(retry).not.toHaveBeenCalled()
        expect(successorFinish).toHaveBeenCalledOnce()
        expect(await storedKeys()).toEqual([])
      }

      it('keeps the successor\'s name when a holder stalled before its first read resumes', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const stall = holdManifestReadUnderLease(1)
        const staleFinish = neverFinishes()
        const stale = storeUploadChunk(chunk(1, 2, 'b'), staleFinish)
        await stall.reached.promise

        advance(UPLOAD_FINALIZER_LEASE_MS)
        const successor = finishGated()
        const successorRequest = storeUploadChunk(chunk(1, 2, 'b'), successor.finish)
        await successor.entered.promise
        const name = await finalizerName()
        expect(name).toEqual(expect.any(String))

        // It reads the successor's name now, and its lease says that name is no predecessor's.
        stall.gate.resolve()
        await expect(stale).resolves.toEqual({ status: 'finalizing' })
        expect(staleFinish).not.toHaveBeenCalled()

        await expectSuccessorKept(successor.gate, successorRequest, successor.finish, name)
      })

      it('keeps the successor\'s name when a holder stalled at its write decides again after the conflict', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const [stall] = holdNamings(1)
        const staleFinish = neverFinishes()
        const stale = storeUploadChunk(chunk(1, 2, 'b'), staleFinish)
        await stall!.reached.promise

        advance(UPLOAD_FINALIZER_LEASE_MS)
        const successor = finishGated()
        const successorRequest = storeUploadChunk(chunk(1, 2, 'b'), successor.finish)
        await successor.entered.promise
        const name = await finalizerName()
        expect(name).toEqual(expect.any(String))

        stall!.gate.resolve()
        await expect(stale).resolves.toEqual({ status: 'finalizing' })
        expect(staleFinish).not.toHaveBeenCalled()

        await expectSuccessorKept(successor.gate, successorRequest, successor.finish, name)
      })

      it('backs both out when a stalled write lands before its successor\'s, and the next retry takes over', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const [staleWrite, successorWrite] = holdNamings(2)
        const staleFinish = neverFinishes()
        const stale = storeUploadChunk(chunk(1, 2, 'b'), staleFinish)
        await staleWrite!.reached.promise

        advance(UPLOAD_FINALIZER_LEASE_MS)
        const successorFinish = neverFinishes()
        const successor = storeUploadChunk(chunk(1, 2, 'b'), successorFinish)
        await successorWrite!.reached.promise

        // The stale write lands, as nothing has changed the manifest; its lease then stops it before any work.
        staleWrite!.gate.resolve()
        await expect(stale).resolves.toEqual({ status: 'finalizing' })
        const staleName = await finalizerName()
        expect(staleName).toEqual(expect.any(String))

        // The successor read another name than it finds now.
        successorWrite!.gate.resolve()
        await expect(successor).resolves.toEqual({ status: 'finalizing' })
        expect(await finalizerName()).toBe(staleName)
        expect(staleFinish).not.toHaveBeenCalled()
        expect(successorFinish).not.toHaveBeenCalled()
        expect(await storedKeys()).toHaveLength(2)

        const finish = finishReading()
        await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
        expect(finish).toHaveBeenCalledOnce()
        expect(await finalizerName()).not.toBe(staleName)
      })

      it('takes over from a predecessor that died', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const dead = finishGated()
        const deadRequest = storeUploadChunk(chunk(1, 2, 'b'), dead.finish)
        await dead.entered.promise
        const deadName = await finalizerName()
        expect(deadName).toEqual(expect.any(String))

        advance(UPLOAD_FINALIZER_LEASE_MS)
        const finish = finishReading()
        const answer = await storeUploadChunk(chunk(1, 2, 'b'), finish)

        expect(answer).toMatchObject({ status: 'finished', response: { body: { content: 'ab' } } })
        expect(finish).toHaveBeenCalledOnce()
        const name = await finalizerName()
        expect(name).toEqual(expect.any(String))
        expect(name).not.toBe(deadName)
        const retry = neverFinishes()
        await expect(storeUploadChunk(chunk(1, 2, 'b'), retry)).resolves.toEqual(answer)
        expect(retry).not.toHaveBeenCalled()

        dead.gate.resolve()
        await deadRequest
        expect(await finalizerName()).toBe(name)
      })

      it('uses the answer a stale holder kept while its successor was about to name itself', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const stale = finishGated()
        const staleRequest = storeUploadChunk(chunk(1, 2, 'b'), stale.finish)
        await stale.entered.promise

        advance(UPLOAD_FINALIZER_LEASE_MS)
        const [write] = holdNamings(1)
        const successorFinish = neverFinishes()
        const successor = storeUploadChunk(chunk(1, 2, 'b'), successorFinish)
        await write!.reached.promise

        stale.gate.resolve()
        const answer = await staleRequest
        expect(await manifest()).toMatchObject({ state: 'completed' })

        write!.gate.resolve()
        await expect(successor).resolves.toEqual(answer)
        expect(successorFinish).not.toHaveBeenCalled()
      })

      it('answers from the kept answer without renewing a lease it got after the end', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const running = finishGated()
        const runningRequest = storeUploadChunk(chunk(1, 2, 'b'), running.finish)
        await running.entered.promise

        const lease = holdNextLeaseRequest()
        const late = neverFinishes()
        const lateRequest = storeUploadChunk(chunk(1, 2, 'b'), late)
        await lease.reached.promise
        running.gate.resolve()
        const kept = await runningRequest

        const compareAndSet = vi.spyOn(appState(), 'compareAndSet')
        compareAndSet.mockClear()
        lease.gate.resolve()
        await expect(lateRequest).resolves.toEqual(kept)
        expect(late).not.toHaveBeenCalled()
        expect(leaseRenewals()).toBe(0)
      })

      it('refuses without renewing the lease when the manifest expired before its first read', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const stall = holdManifestReadUnderLease(1)
        const finish = neverFinishes()
        const request = storeUploadChunk(chunk(1, 2, 'b'), finish)
        await stall.reached.promise
        advance(UPLOAD_IDLE_EXPIRY_MS)

        const compareAndSet = vi.spyOn(appState(), 'compareAndSet')
        compareAndSet.mockClear()
        stall.gate.resolve()
        await expect(request).rejects.toBeInstanceOf(UploadConflictError)
        expect(finish).not.toHaveBeenCalled()
        expect(leaseRenewals()).toBe(0)
        expect(await manifest()).toBeUndefined()
      })

      it('refuses and brings nothing back when the manifest expires between its read and its write', async () => {
        await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
        const stall = holdManifestReadUnderLease(2)
        const finish = neverFinishes()
        const request = storeUploadChunk(chunk(1, 2, 'b'), finish)
        await stall.reached.promise
        advance(UPLOAD_IDLE_EXPIRY_MS)

        stall.gate.resolve()
        await expect(request).rejects.toBeInstanceOf(UploadConflictError)
        expect(finish).not.toHaveBeenCalled()
        expect(await manifest()).toBeUndefined()
      })
    })

    describe('over a long run', () => {
      const STEP = 30_000

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: T0 })
      })

      async function runFor(ms: number) {
        for (let at = 0; at < ms; at += STEP) await vi.advanceTimersByTimeAsync(STEP)
      }

      it('keeps renewing the lease while a slow stream is read', async () => {
        const streamGate = deferred()
        const streamReached = deferred()
        const realStream = store.stream.bind(store)
        vi.spyOn(store, 'stream').mockImplementationOnce(async (key) => {
          streamReached.resolve()
          await streamGate.promise
          return realStream(key)
        })
        const request = storeUploadChunk(chunk(0, 1, 'a'), finishReading())
        await streamReached.promise

        await runFor(10 * UPLOAD_FINALIZER_LEASE_MS)

        await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual({ status: 'finalizing' })
        streamGate.resolve()
        await expect(request).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'a' } } })
      })

      describe('losing the lease while reading', () => {
        /** The next renewal cannot reach AppState, so the holder knows it lost the lease. */
        function failRenewals() {
          const state = appState()
          const compareAndSet = state.compareAndSet.bind(state)
          vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
            if (key.path.startsWith('claim:upload-finalize/')) throw new Error('AppState is out of reach')
            return compareAndSet(key, expected, value, options)
          })
        }

        it('errors the stream between reads, stops reading, and leaves the upload for a retry', async () => {
          await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
          const opened = vi.spyOn(store, 'stream')
          const firstRead = deferred()
          const goOn = deferred()
          let error: unknown = null
          const request = storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
            const reader = stream().getReader()
            await reader.read()
            firstRead.resolve()
            await goOn.promise
            try {
              await reader.read()
            } catch (caught) {
              error = caught
              throw caught
            }
            return { status: 200, body: {} }
          })
          await firstRead.promise

          failRenewals()
          await runFor(2 * STEP)
          goOn.resolve()

          await expect(request).resolves.toEqual({ status: 'finalizing' })
          expect(error).toMatchObject({ name: 'LeaseLostError' })
          expect(opened).toHaveBeenCalledOnce()
          expect(await manifest()).toMatchObject({ state: 'finalizing' })
          expect(await storedKeys()).toHaveLength(2)

          vi.restoreAllMocks()
          await runFor(UPLOAD_FINALIZER_LEASE_MS)
          await expect(storeUploadChunk(chunk(1, 2, 'bb'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'aabb' } } })
        })

        it('errors a read that is waiting on a slow chunk, and closes that chunk', async () => {
          const cancelled = vi.fn()
          vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({ cancel: cancelled }))
          const reading = deferred()
          let error: unknown = null
          const request = storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
            const read = stream().getReader().read()
            reading.resolve()
            try {
              await read
            } catch (caught) {
              error = caught
              throw caught
            }
            return { status: 200, body: {} }
          })
          await reading.promise
          // Let it open the chunk it will wait on.
          await new Promise((resolve) => setImmediate(resolve))

          failRenewals()
          await runFor(2 * STEP)

          await expect(request).resolves.toEqual({ status: 'finalizing' })
          expect(error).toMatchObject({ name: 'LeaseLostError' })
          expect(cancelled).toHaveBeenCalledOnce()
        })

        it('keeps no answer when `finish` makes one of the lost lease', async () => {
          // A chunk that never comes, so the read is waiting when the lease goes.
          vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>())
          const reading = deferred()
          const request = storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
            const read = stream().getReader().read()
            reading.resolve()
            await read.catch(() => undefined)
            return { status: 500, body: { error: 'Failed to upload file' } }
          })
          await reading.promise
          await new Promise((resolve) => setImmediate(resolve))

          failRenewals()
          await runFor(2 * STEP)

          await expect(request).resolves.toEqual({ status: 'finalizing' })
          expect(await manifest()).toMatchObject({ state: 'finalizing' })
        })

        it('errors a stream asked for after the lease was lost', async () => {
          const go = deferred()
          let error: unknown = null
          const request = storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
            await go.promise
            try {
              await readAll(stream())
            } catch (caught) {
              error = caught
              throw caught
            }
            return { status: 200, body: {} }
          })
          await vi.waitFor(async () => expect((await manifest() as { finalizer?: unknown } | undefined)?.finalizer).toEqual(expect.any(String)))
          await new Promise((resolve) => setImmediate(resolve))

          failRenewals()
          await runFor(2 * STEP)
          go.resolve()

          await expect(request).resolves.toEqual({ status: 'finalizing' })
          expect(error).toMatchObject({ name: 'LeaseLostError' })
        })

        it('keeps the answer of a consumer that had read everything before the lease was lost', async () => {
          const readEverything = deferred()
          const goOn = deferred()
          const response = { status: 200, body: { done: true } }
          const request = storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
            await readAll(stream())
            readEverything.resolve()
            await goOn.promise
            return response
          })
          await readEverything.promise

          failRenewals()
          await runFor(2 * STEP)
          goOn.resolve()

          await expect(request).resolves.toEqual({ status: 'finished', response })
          expect(await manifest()).toMatchObject({ state: 'completed', response })
        })
      })

      it('keeps the manifest and the lease while the work outlasts the idle expiry', async () => {
        const { finish, entered, gate } = finishGated()
        const request = storeUploadChunk(chunk(0, 1, 'a'), finish)
        await entered.promise

        await runFor(3 * UPLOAD_IDLE_EXPIRY_MS)

        expect((await manifest())?.state).toBe('finalizing')
        await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual({ status: 'finalizing' })
        gate.resolve()
        const result = await request
        await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual(result)
      })
    })
  })

  describe('lost answers', () => {
    it('settles a reservation whose answer was lost', async () => {
      const lost = loseAnswerOfWrite((value) => value.state === 'receiving' && Object.keys(value.reservations).length === 1)
      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).resolves.toEqual({ status: 'received' })
      expect(lost()).toBe(true)
      expect(await manifest()).toMatchObject({ state: 'receiving', reservations: {} })
      expect(await storedKeys()).toHaveLength(1)
      // It found its own reservation and did not write it again.
      const reservationWrites = vi.mocked(appState().compareAndSet).mock.calls.filter(([, , value]) => (
        (value as UploadManifest).state === 'receiving' && Object.keys((value as Extract<UploadManifest, { state: 'receiving' }>).reservations).length === 1
      ))
      expect(reservationWrites).toHaveLength(1)
    })

    it('settles a commit whose answer was lost, and keeps its bytes', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      const lost = loseAnswerOfWrite((value) => Object.keys(value.chunks).length === 2)
      await expect(storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())).resolves.toEqual({ status: 'received' })
      expect(lost()).toBe(true)
      expect(await storedKeys()).toHaveLength(2)

      await expect(storeUploadChunk(chunk(2, 3, 'c'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'abc' } } })
    })

    it('still claims the assembly when the answer to the commit that claimed it was lost', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const lost = loseAnswerOfWrite((value) => value.state === 'finalizing' && value.finalizer === null)
      const finish = finishReading()

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'ab' } } })

      expect(lost()).toBe(true)
      expect(finish).toHaveBeenCalledOnce()
    })

    it('still takes over when the answer to naming itself was lost', async () => {
      const lost = loseAnswerOfWrite((value) => value.state === 'finalizing' && value.finalizer !== null)
      const finish = finishReading()
      const answer = await storeUploadChunk(chunk(0, 1, 'a'), finish)
      expect(answer).toMatchObject({ status: 'finished' })
      expect(lost()).toBe(true)
      expect(finish).toHaveBeenCalledOnce()
      expect(await manifest()).toMatchObject({ state: 'completed' })
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual(answer)
      // It found its own name and did not write it again.
      const namings = vi.mocked(appState().compareAndSet).mock.calls.filter(([, , value]) => (
        (value as UploadManifest).state === 'finalizing' && (value as { finalizer: string | null }).finalizer !== null
      ))
      expect(namings).toHaveLength(1)
    })

    it('keeps the answer and removes the chunks when the answer to publishing was lost', async () => {
      const lost = loseAnswerOfWrite((value) => value.state === 'completed')
      const finish = finishReading()
      const result = await storeUploadChunk(chunk(0, 1, 'a'), finish)
      expect(lost()).toBe(true)
      expect(await storedKeys()).toEqual([])
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual(result)
      expect(finish).toHaveBeenCalledOnce()
    })

    it('gives back a reservation whose release answer was lost', async () => {
      vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('disk full'))
      const lost = loseAnswerOfWrite((value) => value.state === 'receiving' && Object.keys(value.reservations).length === 0)
      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).rejects.toThrow('disk full')
      expect(lost()).toBe(true)
      expect(await manifest()).toMatchObject({ state: 'receiving', reservations: {} })
    })

    it('leaves the bytes when a commit cannot be settled, as it may have landed, and a retry finds it', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const state = appState()
      const compareAndSet = state.compareAndSet.bind(state)
      const get = state.get.bind(state)
      let landed = false
      vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        const answer = await compareAndSet(key, expected, value, options)
        if (key.path.startsWith('upload/') && Object.keys((value as UploadManifest).chunks).length === 2) {
          landed = true
          throw new Error('connection lost')
        }
        return answer
      })
      vi.spyOn(state, 'get').mockImplementation(((key: never) => {
        if (landed) throw new Error('still down')
        return get(key)
      }) as typeof state.get)

      await expect(storeUploadChunk(chunk(1, 2, 'b'), neverFinishes())).rejects.toThrow('still down')
      expect(await storedKeys()).toHaveLength(2)

      vi.restoreAllMocks()
      await expect(storeUploadChunk(chunk(1, 2, 'b'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
    })

    it('answers with its own work when the answer cannot be kept, and leaves the rest to a retry and the sweep', async () => {
      const state = appState()
      const compareAndSet = state.compareAndSet.bind(state)
      vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        if ((value as UploadManifest).state === 'completed') throw new Error('connection lost')
        return compareAndSet(key, expected, value, options)
      })
      const finish = finishReading()

      await expect(storeUploadChunk(chunk(0, 1, 'a'), finish)).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'a' } } })

      vi.restoreAllMocks()
      expect((await manifest())?.state).toBe('finalizing')
      expect(await storedKeys()).toHaveLength(1)
      // Not exactly once: this retry runs the work a second time.
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finish)).resolves.toMatchObject({ status: 'finished' })
      expect(finish).toHaveBeenCalledTimes(2)
    })
  })

  describe('the sweep', () => {
    it('keeps an old chunk while its upload is still receiving', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      advance(50 * MINUTE)
      await storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())
      advance(50 * MINUTE)

      await cleanupStaleTempUploads(HOUR)

      expect(await storedKeys()).toHaveLength(2)
      await expect(storeUploadChunk(chunk(2, 3, 'c'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'abc' } } })
    })

    it('keeps bytes whose attempt still holds a reservation, however old they look', async () => {
      const inFlight = holdNextPut()
      const write = storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await inFlight.stored.promise

      await cleanupStaleTempUploads(1, Date.now() + 1000)

      expect(await storedKeys()).toHaveLength(1)
      inFlight.gate.resolve()
      await expect(write).resolves.toEqual({ status: 'received' })
    })

    /** A `finish` that had its file written and waits for the test. */
    function finishSpooled() {
      const entered = deferred<string>()
      const gate = deferred()
      const finish = async ({ toFile }: AssembledUpload): Promise<UploadResponse> => {
        entered.resolve(await toFile())
        await gate.promise
        return { status: 200, body: {} }
      }
      return { finish, entered, gate }
    }

    it('keeps the chunks and the file of a running finalizer, however old they look', async () => {
      const { finish, entered, gate } = finishSpooled()
      const request = storeUploadChunk(chunk(0, 1, 'a'), finish)
      const filePath = await entered.promise
      const longAgo = new Date(T0 - 2 * HOUR)
      await fs.promises.utimes(filePath, longAgo, longAgo)

      await cleanupStaleTempUploads(1, Date.now() + 1000)

      expect(await storedKeys()).toHaveLength(1)
      expect(fs.existsSync(filePath)).toBe(true)
      gate.resolve()
      await expect(request).resolves.toMatchObject({ status: 'finished' })
    })

    it('removes bytes whose manifest expired, once they are old enough', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      advance(UPLOAD_IDLE_EXPIRY_MS)
      expect(await manifest()).toBeUndefined()

      await cleanupStaleTempUploads(UPLOAD_IDLE_EXPIRY_MS)
      expect(await storedKeys()).toHaveLength(1)

      advance(1)
      await cleanupStaleTempUploads(UPLOAD_IDLE_EXPIRY_MS)
      expect(await storedKeys()).toEqual([])
    })

    it('removes old bytes the live manifest no longer refers to, and only those', async () => {
      await storeUploadChunk(chunk(0, 2, 'old'), neverFinishes())
      advance(50 * MINUTE)
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('store unavailable'))
      await storeUploadChunk(chunk(0, 2, 'new'), neverFinishes())
      expect(await storedKeys()).toHaveLength(2)
      advance(11 * MINUTE)

      await cleanupStaleTempUploads(HOUR)

      expect(await storedKeys()).toHaveLength(1)
      await expect(storeUploadChunk(chunk(1, 2, '!'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'new!' } } })
    })

    it('removes bytes a finished upload could not delete, and keeps its answer', async () => {
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('store unavailable'))
      const result = await storeUploadChunk(chunk(0, 1, 'a'), finishReading())
      expect(await storedKeys()).toHaveLength(1)
      advance(HOUR - 1)
      await cleanupStaleTempUploads(HOUR - 2)

      expect(await storedKeys()).toEqual([])
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).resolves.toEqual(result)
    })

    it('removes the bytes and the file of a finalizer that died, after its manifest idled out', async () => {
      const { finish, entered, gate } = finishSpooled()
      // As good as dead: it does nothing more until the end of this test.
      const dead = storeUploadChunk(chunk(0, 1, 'a'), finish)
      const filePath = await entered.promise
      const longAgo = new Date(T0 - 2 * HOUR)
      await fs.promises.utimes(filePath, longAgo, longAgo)

      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      await cleanupStaleTempUploads(HOUR)

      expect(await storedKeys()).toEqual([])
      expect(fs.existsSync(filePath)).toBe(false)

      // And if it was only asleep, it finds its upload gone and brings nothing back.
      gate.resolve()
      await expect(dead).resolves.toMatchObject({ status: 'finished' })
      expect(await manifest()).toBeUndefined()
    })

    it('leaves everything when the manifest cannot be read', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      advance(50 * MINUTE)
      const get = vi.spyOn(appState(), 'get').mockRejectedValueOnce(new Error('AppState is down'))

      await cleanupStaleTempUploads(1)

      expect(get).toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(1)
    })

    it('leaves bytes alone until AppState is initialized', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await closeAppState()
      advance(2 * HOUR)

      await expect(cleanupStaleTempUploads(HOUR)).resolves.toBeUndefined()

      expect(await storedKeys()).toHaveLength(1)
    })

    it('ignores keys it did not write', async () => {
      await store.put('uploads/not-an-upload', new Uint8Array(1))
      advance(2 * HOUR)
      await cleanupStaleTempUploads(HOUR)
      expect(await storedKeys()).toEqual(['uploads/not-an-upload'])
    })
  })
})

describe('the local disk store', () => {
  const store = localDiskUploadByteStore

  it('refuses a key outside its folder', async () => {
    await expect(store.put('uploads/../../etc/passwd', new Uint8Array(1))).rejects.toThrow('Invalid upload bytes key')
    await expect(store.put('elsewhere/a', new Uint8Array(1))).rejects.toThrow('Invalid upload bytes key')
    await expect(store.delete('uploads/a/../../b')).rejects.toThrow('Invalid upload bytes key')
  })

  it('answers null for bytes it does not have, and ignores a delete of them', async () => {
    await expect(store.stream('uploads/a/b/c')).resolves.toBeNull()
    await expect(store.delete('uploads/a/b/c')).resolves.toBeUndefined()
    await expect(store.list('uploads/')).resolves.toEqual([])
  })

  it('lists by prefix with sizes, and removes folders it leaves empty', async () => {
    await store.put('uploads/a/b/one', new Uint8Array(3))
    await store.put('uploads/a/c/two', new Uint8Array(5))
    await expect(store.list('uploads/a/b/')).resolves.toEqual([{ key: 'uploads/a/b/one', size: 3 }])

    await store.delete('uploads/a/b/one')
    expect(fs.existsSync(path.join(tempUploadsDir, 'chunks', 'a', 'b'))).toBe(false)
    expect(fs.existsSync(path.join(tempUploadsDir, 'chunks', 'a', 'c', 'two'))).toBe(true)

    await store.delete('uploads/a/c/two')
    expect(fs.existsSync(path.join(tempUploadsDir, 'chunks', 'a'))).toBe(false)
    expect(fs.existsSync(path.join(tempUploadsDir, 'chunks'))).toBe(true)
  })

  it('never overwrites a key', async () => {
    await store.put('uploads/a/b/one', new Uint8Array(3))
    await expect(store.put('uploads/a/b/one', new Uint8Array(1))).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('writes again when another delete removes the folder under it', async () => {
    const writeFile = vi.spyOn(fs.promises, 'writeFile').mockImplementationOnce(async () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })
    await store.put('uploads/a/b/one', new Uint8Array(3))
    expect(writeFile).toHaveBeenCalledTimes(2)
    await expect(store.list('uploads/')).resolves.toEqual([{ key: 'uploads/a/b/one', size: 3 }])
  })
})

describe('the manifest schema', () => {
  const receiving = {
    target: 'agent:a',
    totalChunks: 2,
    maxBytes: 10,
    state: 'receiving',
    chunks: { 0: { attemptId: `${T0}-11111111-1111-1111-1111-111111111111`, hash: 'h', size: 1 } },
    reservations: {},
  }

  it('reads back what it was given', () => {
    expect(uploadManifestSchema.parse(receiving)).toEqual(receiving)
  })

  it.each<[string, Record<string, unknown>]>([
    ['more chunks than an upload may have', { totalChunks: 201 }],
    ['an unknown state', { state: 'done' }],
    ['a chunk at no index', { chunks: { x: receiving.chunks[0] } }],
    ['a chunk whose attempt is not named as one', { chunks: { 0: { ...receiving.chunks[0], attemptId: '../../x' } } }],
    ['a reservation under a name that is no attempt', { reservations: { x: { index: 0, hash: 'h', size: 1, expiresAt: 1 } } }],
  ])('refuses %s', (_what, change) => {
    expect(uploadManifestSchema.safeParse({ ...receiving, ...change }).success).toBe(false)
  })
})

describe('cleanupStaleTempUploads, for the layout before manifests', () => {
  it('removes stale chunk dirs and orphaned .assembled files by age, and not the current layout', async () => {
    const staleDir = path.join(tempUploadsDir, '11111111-1111-1111-1111-111111111111')
    const freshDir = path.join(tempUploadsDir, '22222222-2222-2222-2222-222222222222')
    const staleAssembled = path.join(tempUploadsDir, '33333333-3333-3333-3333-333333333333.assembled')
    const freshAssembled = path.join(tempUploadsDir, '44444444-4444-4444-4444-444444444444.assembled')
    const chunksDir = path.join(tempUploadsDir, 'chunks')
    const assembledDir = path.join(tempUploadsDir, 'assembled')

    await Promise.all([staleDir, freshDir, chunksDir, assembledDir].map((dir) => fs.promises.mkdir(dir)))
    await fs.promises.writeFile(staleAssembled, 'orphan')
    await fs.promises.writeFile(freshAssembled, 'in-flight')

    const now = T0 + HOUR
    const old = new Date(T0 - HOUR)
    const fresh = new Date(T0 + HOUR)
    await Promise.all([staleDir, staleAssembled, chunksDir, assembledDir].map((entry) => fs.promises.utimes(entry, old, old)))
    await Promise.all([freshDir, freshAssembled].map((entry) => fs.promises.utimes(entry, fresh, fresh)))

    await cleanupStaleTempUploads(HOUR, now)

    expect(fs.existsSync(staleDir)).toBe(false)
    expect(fs.existsSync(staleAssembled)).toBe(false)
    expect(fs.existsSync(freshDir)).toBe(true)
    expect(fs.existsSync(freshAssembled)).toBe(true)
    expect(fs.existsSync(chunksDir)).toBe(true)
    expect(fs.existsSync(assembledDir)).toBe(true)
  })

  it('cleans it up without AppState', async () => {
    await closeAppState()
    const staleDir = path.join(tempUploadsDir, '11111111-1111-1111-1111-111111111111')
    await fs.promises.mkdir(staleDir)
    const old = new Date(T0 - 2 * HOUR)
    await fs.promises.utimes(staleDir, old, old)

    await cleanupStaleTempUploads(HOUR)

    expect(fs.existsSync(staleDir)).toBe(false)
  })
})

describe('formatUploadTooLargeMessage', () => {
  it('matches UploadTooLargeError message', () => {
    const message = formatUploadTooLargeMessage(150 * 1024 * 1024, 100 * 1024 * 1024)
    expect(message).toBe('File too large (150.0MB, max 100MB)')
    expect(new UploadTooLargeError(150 * 1024 * 1024, 100 * 1024 * 1024).message).toBe(message)
  })
})

describe('MAX_UPLOAD_TOTAL_SIZE', () => {
  it('is 2 GiB', () => {
    expect(MAX_UPLOAD_TOTAL_SIZE).toBe(2 * 1024 * 1024 * 1024)
  })
})
