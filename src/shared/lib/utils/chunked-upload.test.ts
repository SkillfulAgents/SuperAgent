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

/** A store in memory: the second adapter, standing in for a deployment's blob store. */
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

/** The usual `finish`: answers with what the assembled file holds. */
function finishReading() {
  return vi.fn(async ({ filePath }: AssembledUpload): Promise<UploadResponse> => ({
    status: 200,
    body: { content: await fs.promises.readFile(filePath, 'utf8') },
  }))
}

/** A `finish` that has read the file and then waits for the test. */
function finishGated() {
  const entered = deferred<AssembledUpload>()
  const gate = deferred()
  const finish = vi.fn(async (assembled: AssembledUpload): Promise<UploadResponse> => {
    const content = await fs.promises.readFile(assembled.filePath, 'utf8')
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
  ['a blob store', memoryByteStore],
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
    it('answers received until every chunk has arrived, then hands over the file and removes its bytes', async () => {
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
      expect(fs.existsSync(finish.mock.calls[0]![0].filePath)).toBe(false)
      expect((await manifest())?.state).toBe('completed')
    })

    it('finishes an upload of one chunk on that chunk', async () => {
      const finish = finishReading()
      await expect(storeUploadChunk(chunk(0, 1, 'only'), finish)).resolves.toMatchObject({ status: 'finished', response: { body: { content: 'only' } } })
    })

    it('assembles by streaming, without reading a chunk whole', async () => {
      await storeUploadChunk(chunk(0, 2, 'hello '), neverFinishes())
      const readFile = vi.spyOn(fs.promises, 'readFile')
      let readsBeforeFinish = -1
      const result = await storeUploadChunk(chunk(1, 2, 'world'), vi.fn(async ({ filePath }: AssembledUpload) => {
        readsBeforeFinish = readFile.mock.calls.length
        return { status: 200, body: { content: await fs.promises.readFile(filePath, 'utf8') } }
      }))
      expect(readsBeforeFinish).toBe(0)
      expect(result).toMatchObject({ response: { body: { content: 'hello world' } } })
    })

    it('leaves a file the caller moved alone, and has nothing left to remove', async () => {
      const moved = path.join(tmpRoot, 'moved')
      const result = await storeUploadChunk(chunk(0, 1, 'x'), async ({ filePath }) => {
        await fs.promises.rename(filePath, moved)
        return { status: 200, body: {} }
      })
      expect(result.status).toBe('finished')
      expect(await fs.promises.readFile(moved, 'utf8')).toBe('x')
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

    it('stops before the work when the lease was lost during assembly, and a retry starts over', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const streamGate = deferred()
      const streamReached = deferred()
      const realStream = store.stream.bind(store)
      vi.spyOn(store, 'stream').mockImplementationOnce(async (key) => {
        streamReached.resolve()
        await streamGate.promise
        return realStream(key)
      })
      const finish = neverFinishes()
      const request = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await streamReached.promise

      advance(UPLOAD_FINALIZER_LEASE_MS)
      streamGate.resolve()

      await expect(request).resolves.toEqual({ status: 'finalizing' })
      expect(finish).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)
      const assembled = path.join(tempUploadsDir, 'assembled')
      expect(await fs.promises.readdir(assembled)).toEqual([])

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finishReading())).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
    })

    it('keeps the upload for a retry when assembly fails', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      vi.spyOn(store, 'stream').mockRejectedValueOnce(new Error('store unavailable'))
      const finish = finishReading()

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).rejects.toThrow('store unavailable')
      expect(finish).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)
      expect(await fs.promises.readdir(path.join(tempUploadsDir, 'assembled'))).toEqual([])

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).resolves.toMatchObject({ response: { body: { content: 'ab' } } })
      expect(finish).toHaveBeenCalledOnce()
    })

    it('fails assembly when a chunk has gone missing, rather than hand over a short file', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await store.delete((await storedKeys())[0]!)
      const finish = neverFinishes()
      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).rejects.toThrow('is missing')
      expect(finish).not.toHaveBeenCalled()
    })

    it('fails assembly when a chunk came back with another size', async () => {
      vi.spyOn(store, 'stream').mockResolvedValueOnce(new Blob(['short']).stream() as ReadableStream<Uint8Array>)
      const finish = neverFinishes()
      await expect(storeUploadChunk(chunk(0, 1, 'the whole chunk'), finish)).rejects.toThrow('Assembled upload is 5 bytes')
      expect(finish).not.toHaveBeenCalled()
    })

    it('leaves the upload for a retry when `finish` throws', async () => {
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async () => {
        throw new Error('work failed')
      })).rejects.toThrow('work failed')
      expect((await manifest())?.state).toBe('finalizing')

      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).resolves.toMatchObject({ status: 'finished' })
    })

    describe('over a long run', () => {
      const STEP = 30_000

      beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: T0 })
      })

      async function runFor(ms: number) {
        for (let at = 0; at < ms; at += STEP) await vi.advanceTimersByTimeAsync(STEP)
      }

      it('keeps renewing the lease while a slow stream is assembled', async () => {
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
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finish)).resolves.toMatchObject({ status: 'finished' })
      expect(lost()).toBe(true)
      expect(finish).toHaveBeenCalledOnce()
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

    it('keeps the chunks and the file of a running finalizer, however old they look', async () => {
      const { finish, entered, gate } = finishGated()
      const request = storeUploadChunk(chunk(0, 1, 'a'), finish)
      const { filePath } = await entered.promise
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
      const { finish, entered, gate } = finishGated()
      // As good as dead: it does nothing more until the end of this test.
      const dead = storeUploadChunk(chunk(0, 1, 'a'), finish)
      const { filePath } = await entered.promise
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
