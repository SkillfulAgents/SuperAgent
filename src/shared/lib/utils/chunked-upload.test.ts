import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import os from 'os'
import path from 'path'
import { appState, closeAppState, digestKeyPart } from '@shared/lib/app-state'
import { LocalFileOps } from '@shared/lib/agent-actor/local-file-ops'
import {
  MAX_UPLOAD_TOTAL_SIZE,
  UPLOAD_IDLE_EXPIRY_MS,
  UploadConflictError,
  UploadOutcomeUnknownError,
  UploadTooLargeError,
  cleanupStaleTempUploads,
  formatUploadTooLargeMessage,
  storeUploadChunk,
  uploadManifestKey,
  type AssembledUpload,
  type StoreChunkInput,
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
const NEW_UPLOAD_ID = '22222222-2222-2222-2222-222222222222'
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
const blobStream = (text: string) => new Blob([text]).stream() as ReadableStream<Uint8Array>
const tick = () => new Promise((resolve) => setImmediate(resolve))

/** The usual `finish`: returns what the upload's stream holds. */
function finishReading() {
  return vi.fn(async (assembled: AssembledUpload) => readAll(assembled.stream()))
}

/** A `finish` that waits for the test before it does anything. */
function finishGated() {
  const entered = deferred<AssembledUpload>()
  const gate = deferred()
  const finish = vi.fn(async (assembled: AssembledUpload) => {
    entered.resolve(assembled)
    await gate.promise
    return readAll(assembled.stream())
  })
  return { finish, entered, gate }
}

const neverFinishes = () => vi.fn(async (): Promise<string> => {
  throw new Error('finish should not have run')
})

async function manifest(ownerId = OWNER, uploadId = UPLOAD_ID): Promise<UploadManifest | undefined> {
  return (await appState().get(uploadManifestKey(ownerId, uploadId)))?.value
}

const isManifestWrite = (key: { path: string }) => key.path.startsWith('upload/')

/** The next write of a manifest that `matches` lands in the backend, and its answer is lost. */
function loseAnswerOfWrite(matches: (value: UploadManifest) => boolean) {
  const state = appState()
  const compareAndSet = state.compareAndSet.bind(state)
  let lost = false
  vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
    const answer = await compareAndSet(key, expected, value, options)
    if (!lost && answer.ok && isManifestWrite(key) && matches(value as UploadManifest)) {
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
  ['an in-memory stand-in', memoryByteStore],
])('chunked uploads over %s', (_name, createStore) => {
  let store: UploadByteStore

  beforeEach(() => {
    store = createStore()
    setUploadByteStore(store)
  })

  const storedKeys = async () => (await store.list('uploads/')).map(({ key }) => key)

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

  /** What a new upload can do once this one ended: send the whole file again. */
  async function expectANewUploadWorks() {
    const result = await storeUploadChunk(chunk(0, 1, 'again', { uploadId: NEW_UPLOAD_ID }), finishReading())
    expect(result).toEqual({ status: 'finished', result: 'again' })
  }

  describe('storing chunks', () => {
    it('answers received until the last chunk, then runs finish, returns its result and removes the bytes', async () => {
      const finish = finishReading()
      await expect(storeUploadChunk(chunk(0, 3, 'aa'), finish)).resolves.toEqual({ status: 'received' })
      await expect(storeUploadChunk(chunk(1, 3, 'bb'), finish)).resolves.toEqual({ status: 'received' })
      expect(finish).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)

      const result = await storeUploadChunk(chunk(2, 3, 'cc'), finish)

      expect(result).toEqual({ status: 'finished', result: 'aabbcc' })
      expect(finish).toHaveBeenCalledOnce()
      expect(finish.mock.calls[0]![0].size).toBe(6)
      expect(await storedKeys()).toEqual([])
      expect(await manifest()).toEqual({ state: 'ended' })
    })

    it('finishes an upload of one chunk on that chunk', async () => {
      await expect(storeUploadChunk(chunk(0, 1, 'only'), finishReading())).resolves.toEqual({ status: 'finished', result: 'only' })
    })

    it('treats an id in another case as the same upload', async () => {
      await storeUploadChunk(chunk(0, 2, 'a', { uploadId: 'ABCDEF00-1111-1111-1111-111111111111' }), neverFinishes())
      const result = await storeUploadChunk(chunk(1, 2, 'b', { uploadId: 'abcdef00-1111-1111-1111-111111111111' }), finishReading())
      expect(result).toEqual({ status: 'finished', result: 'ab' })
    })

    it('keeps two owners using one upload id apart, in the manifest and in the bytes', async () => {
      await storeUploadChunk(chunk(0, 2, 'mine', { ownerId: 'user-1' }), neverFinishes())
      // Another owner may even disagree on the upload's shape.
      await storeUploadChunk(chunk(0, 3, 'them', { ownerId: 'user-2' }), neverFinishes())

      const keys = await storedKeys()
      expect(keys).toHaveLength(2)
      expect(keys.filter((key) => key.startsWith(`uploads/${digestKeyPart('user-1')}/${UPLOAD_ID}/`))).toHaveLength(1)
      expect(keys.filter((key) => key.startsWith(`uploads/${digestKeyPart('user-2')}/${UPLOAD_ID}/`))).toHaveLength(1)

      const result = await storeUploadChunk(chunk(1, 2, '-1', { ownerId: 'user-1' }), finishReading())
      expect(result).toEqual({ status: 'finished', result: 'mine-1' })
      expect((await manifest('user-2'))?.state).toBe('receiving')
      expect(await storedKeys()).toHaveLength(1)
    })
  })

  describe('one ordered attempt', () => {
    it('refuses a gap and stores nothing, and the upload can still go on', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      const put = vi.spyOn(store, 'put')
      const before = await manifest()

      const refused = storeUploadChunk(chunk(2, 3, 'c'), neverFinishes())
      await expect(refused).rejects.toBeInstanceOf(UploadConflictError)
      await expect(refused).rejects.toThrow('out of order')
      await expect(refused).rejects.toThrow('Start a new upload')

      expect(put).not.toHaveBeenCalled()
      expect(await manifest()).toEqual(before)
      await expect(storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())).resolves.toEqual({ status: 'received' })
    })

    it('refuses a duplicate of a chunk it has', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      await storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())).rejects.toThrow('out of order')
      await expect(storeUploadChunk(chunk(1, 3, 'other'), neverFinishes())).rejects.toThrow('out of order')

      expect(put).not.toHaveBeenCalled()
      expect(await storedKeys()).toHaveLength(2)
    })

    it('refuses chunk 0 on an existing manifest', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      await expect(storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())).rejects.toThrow('out of order')
      expect(await storedKeys()).toHaveLength(1)
    })

    it('refuses chunk N with no manifest, and creates none', async () => {
      const refused = storeUploadChunk(chunk(1, 2, 'b'), neverFinishes())
      await expect(refused).rejects.toBeInstanceOf(UploadConflictError)
      await expect(refused).rejects.toThrow('has not started')
      expect(await manifest()).toBeUndefined()
      expect(await storedKeys()).toEqual([])
    })

    it('refuses an overlap while a write is in flight, and that write goes on', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      const inFlight = holdNextPut()
      const writing = storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())
      await inFlight.stored.promise
      const put = vi.mocked(store.put)

      await expect(storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())).rejects.toThrow('still being written')
      await expect(storeUploadChunk(chunk(2, 3, 'c'), neverFinishes())).rejects.toThrow('still being written')
      // Only the one in flight.
      expect(put).toHaveBeenCalledOnce()

      inFlight.gate.resolve()
      await expect(writing).resolves.toEqual({ status: 'received' })
      await expect(storeUploadChunk(chunk(2, 3, 'c'), finishReading())).resolves.toEqual({ status: 'finished', result: 'abc' })
    })

    it('refuses an overlap on chunk 0 while the manifest is new', async () => {
      const inFlight = holdNextPut()
      const writing = storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await inFlight.stored.promise

      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).rejects.toThrow('still being written')

      inFlight.gate.resolve()
      await expect(writing).resolves.toEqual({ status: 'received' })
    })

    it.each<[string, Partial<StoreChunkInput>]>([
      ['chunk count', { totalChunks: 3 }],
      ['target', { target: 'agent:b' }],
      ['size limit', { maxTotalBytes: CAP + 1 }],
    ])('refuses a later chunk that disagrees on the %s, and stores nothing', async (_what, overrides) => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const before = await manifest()
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 2, 'b', overrides), neverFinishes())).rejects.toThrow('different details')

      expect(put).not.toHaveBeenCalled()
      expect(await manifest()).toEqual(before)
    })
  })

  describe('the claim', () => {
    it('lets one of two simultaneous requests for the last chunk finalize, and refuses the other', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const finish = finishReading()

      const results = await Promise.allSettled([
        storeUploadChunk(chunk(1, 2, 'b'), finish),
        storeUploadChunk(chunk(1, 2, 'b'), finish),
      ])

      expect(finish).toHaveBeenCalledOnce()
      const finished = results.filter((result) => result.status === 'fulfilled')
      const refused = results.filter((result) => result.status === 'rejected')
      expect(finished).toHaveLength(1)
      expect((finished[0] as PromiseFulfilledResult<unknown>).value).toEqual({ status: 'finished', result: 'ab' })
      expect(refused).toHaveLength(1)
      expect((refused[0] as PromiseRejectedResult).reason).toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toEqual([])
    })

    it('does the same when they reach two processes', async () => {
      vi.resetModules()
      const otherBytes = await import('./chunked-upload-bytes')
      otherBytes.setUploadByteStore(store)
      const otherProcess = await import('./chunked-upload')
      expect(otherProcess.storeUploadChunk).not.toBe(storeUploadChunk)

      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const finish = finishReading()
      const results = await Promise.allSettled([
        storeUploadChunk(chunk(1, 2, 'b'), finish),
        otherProcess.storeUploadChunk(chunk(1, 2, 'b'), finish),
      ])

      expect(finish).toHaveBeenCalledOnce()
      expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    })

    it('moves to finalizing with the commit, and refuses anyone who finds it so', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const { finish, entered, gate } = finishGated()
      const running = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await entered.promise
      expect((await manifest())?.state).toBe('finalizing')
      const other = neverFinishes()

      for (const late of [chunk(1, 2, 'b'), chunk(0, 2, 'a'), chunk(1, 2, 'other')]) {
        const refused = storeUploadChunk(late, other)
        await expect(refused).rejects.toBeInstanceOf(UploadConflictError)
        await expect(refused).rejects.toThrow('being processed')
        await expect(refused).rejects.toThrow('Check its result before starting a new upload')
      }
      expect(other).not.toHaveBeenCalled()

      gate.resolve()
      await expect(running).resolves.toEqual({ status: 'finished', result: 'ab' })
    })

    it('refuses anyone who finds the upload ended, and runs nothing again', async () => {
      await storeUploadChunk(chunk(0, 1, 'a'), finishReading())
      const again = neverFinishes()
      const put = vi.spyOn(store, 'put')

      const refused = storeUploadChunk(chunk(0, 1, 'a'), again)
      await expect(refused).rejects.toBeInstanceOf(UploadConflictError)
      await expect(refused).rejects.toThrow('already ended')
      await expect(refused).rejects.toThrow('Check its result before starting a new upload')

      expect(again).not.toHaveBeenCalled()
      expect(put).not.toHaveBeenCalled()
    })

    it('keeps the ended state until it expires, and then the id can start again', async () => {
      await storeUploadChunk(chunk(0, 1, 'a'), finishReading())
      advance(UPLOAD_IDLE_EXPIRY_MS - 1)
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).rejects.toThrow('already ended')
      advance(1)
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).resolves.toEqual({ status: 'finished', result: 'a' })
    })
  })

  describe('a failure', () => {
    it('ends the attempt when a write fails, removes all its bytes, and a new upload works', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      const put = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
        await put(key, bytes.subarray(0, 0))
        throw new Error('disk full')
      })

      await expect(storeUploadChunk(chunk(1, 3, 'bb'), neverFinishes())).rejects.toThrow('disk full')

      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toEqual([])
      await expect(storeUploadChunk(chunk(1, 3, 'bb'), neverFinishes())).rejects.toThrow('already ended')
      await expect(storeUploadChunk(chunk(2, 3, 'cc'), neverFinishes())).rejects.toThrow('already ended')
      await expectANewUploadWorks()
    })

    it('ends the attempt when `finish` throws, removes the bytes, refuses a retry, and a new upload works', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const failing = vi.fn(async (): Promise<string> => {
        throw new Error('work failed')
      })

      await expect(storeUploadChunk(chunk(1, 2, 'b'), failing)).rejects.toThrow('work failed')

      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toEqual([])
      const retry = neverFinishes()
      await expect(storeUploadChunk(chunk(1, 2, 'b'), retry)).rejects.toThrow('already ended')
      expect(retry).not.toHaveBeenCalled()
      expect(failing).toHaveBeenCalledOnce()
      await expectANewUploadWorks()
    })

    it('passes on an unknown outcome as it was thrown, and does not retry', async () => {
      const unknown = new UploadOutcomeUnknownError(new Error('after the import'))
      const failing = vi.fn(async (): Promise<string> => {
        throw unknown
      })

      await expect(storeUploadChunk(chunk(0, 1, 'a'), failing)).rejects.toBe(unknown)

      expect(unknown.message).toContain('its result is unknown. Check before sending it again')
      expect(failing).toHaveBeenCalledOnce()
      expect(await manifest()).toEqual({ state: 'ended' })
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

  describe('a lost answer', () => {
    it('fails a reservation whose answer was lost, writes nothing, and ends the attempt', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const put = vi.spyOn(store, 'put')
      const lost = loseAnswerOfWrite((value) => value.state === 'receiving' && value.writing !== null)

      await expect(storeUploadChunk(chunk(1, 2, 'b'), neverFinishes())).rejects.toThrow('connection lost')

      expect(lost()).toBe(true)
      expect(put).not.toHaveBeenCalled()
      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toEqual([])
    })

    it('fails a commit whose answer was lost, ends the attempt, and removes its bytes', async () => {
      const lost = loseAnswerOfWrite((value) => value.state === 'receiving' && value.chunks.length === 1)

      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).rejects.toThrow('connection lost')

      expect(lost()).toBe(true)
      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toEqual([])
    })

    it('does not run `finish` when the answer to the claim was lost, as this request does not know it won', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const lost = loseAnswerOfWrite((value) => value.state === 'finalizing')
      const finish = neverFinishes()

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).rejects.toThrow('connection lost')

      expect(lost()).toBe(true)
      expect(finish).not.toHaveBeenCalled()
      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toEqual([])
      // One claim, not tried again.
      const claims = vi.mocked(appState().compareAndSet).mock.calls.filter(([, , value]) => (value as UploadManifest).state === 'finalizing')
      expect(claims).toHaveLength(1)
      await expectANewUploadWorks()
    })

    it('leaves it to expiry and the sweep when AppState cannot be reached at all', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const state = appState()
      const compareAndSet = state.compareAndSet.bind(state)
      const get = state.get.bind(state)
      let down = false
      vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        const answer = await compareAndSet(key, expected, value, options)
        if ((value as UploadManifest).state === 'finalizing') {
          down = true
          throw new Error('connection lost')
        }
        return answer
      })
      vi.spyOn(state, 'get').mockImplementation(((key: never) => {
        if (down) throw new Error('still down')
        return get(key)
      }) as typeof state.get)
      const finish = neverFinishes()

      await expect(storeUploadChunk(chunk(1, 2, 'b'), finish)).rejects.toThrow('connection lost')

      expect(finish).not.toHaveBeenCalled()
      vi.restoreAllMocks()
      expect((await manifest())?.state).toBe('finalizing')
      expect(await storedKeys()).toHaveLength(2)

      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      await cleanupStaleTempUploads(HOUR)
      expect(await storedKeys()).toEqual([])
    })

    it('still removes the bytes of a failed write when AppState cannot be reached', async () => {
      const put = store.put.bind(store)
      vi.spyOn(store, 'put').mockImplementationOnce(async (key, bytes) => {
        await put(key, bytes)
        throw new Error('disk full')
      })
      const state = appState()
      const get = state.get.bind(state)
      let reads = 0
      vi.spyOn(state, 'get').mockImplementation(((key: never) => {
        if (++reads > 1) throw new Error('down')
        return get(key)
      }) as typeof state.get)

      await expect(storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())).rejects.toThrow('disk full')

      vi.restoreAllMocks()
      expect(await storedKeys()).toEqual([])
    })
  })

  describe('a late write', () => {
    it('is refused and removes its bytes when the attempt ended while it was in flight', async () => {
      // The first chunk's commit lands, and its answer comes back lost only once the second is writing.
      const state = appState()
      const compareAndSet = state.compareAndSet.bind(state)
      const committed = deferred()
      const answer = deferred()
      let held = false
      vi.spyOn(state, 'compareAndSet').mockImplementation(async (key, expected, value, options) => {
        const written = await compareAndSet(key, expected, value, options)
        const manifestValue = value as UploadManifest
        if (!held && isManifestWrite(key) && manifestValue.state === 'receiving' && manifestValue.chunks.length === 1) {
          held = true
          committed.resolve()
          await answer.promise
          throw new Error('connection lost')
        }
        return written
      })
      const first = storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      await committed.promise
      const inFlight = holdNextPut()
      const second = storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())
      await inFlight.stored.promise

      answer.resolve()
      await expect(first).rejects.toThrow('connection lost')
      expect(await manifest()).toEqual({ state: 'ended' })
      expect(await storedKeys()).toHaveLength(1)

      inFlight.gate.resolve()
      await expect(second).rejects.toBeInstanceOf(UploadConflictError)
      await expect(second).rejects.toThrow('after its upload moved on')
      expect(await storedKeys()).toEqual([])
    })

    it('is refused and removes its bytes when the manifest expired, and does not bring it back', async () => {
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

    it('is refused and touches nothing of the upload that started again under its id', async () => {
      const late = holdNextPut()
      const write = storeUploadChunk(chunk(0, 2, 'old'), neverFinishes())
      await late.stored.promise
      advance(UPLOAD_IDLE_EXPIRY_MS)
      await storeUploadChunk(chunk(0, 2, 'new'), neverFinishes())
      const before = await manifest()

      late.gate.resolve()
      await expect(write).rejects.toBeInstanceOf(UploadConflictError)

      expect(await manifest()).toEqual(before)
      expect(await storedKeys()).toHaveLength(1)
      await expect(storeUploadChunk(chunk(1, 2, '!'), finishReading())).resolves.toEqual({ status: 'finished', result: 'new!' })
    })

    it('holds the slot until the manifest expires when its writer stalls, and every other chunk is refused', async () => {
      await storeUploadChunk(chunk(0, 3, 'a'), neverFinishes())
      const stalled = holdNextPut()
      const write = storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())
      await stalled.stored.promise

      advance(UPLOAD_IDLE_EXPIRY_MS - 1)
      await expect(storeUploadChunk(chunk(1, 3, 'b'), neverFinishes())).rejects.toThrow('still being written')

      // Still in time: nothing else was let in, so it may land.
      stalled.gate.resolve()
      await expect(write).resolves.toEqual({ status: 'received' })
    })
  })

  describe('the size cap', () => {
    it('refuses a chunk that takes the upload over it, ends the attempt, and removes the bytes', async () => {
      await storeUploadChunk(chunk(0, 3, '0123456789', { maxTotalBytes: 15 }), neverFinishes())
      const put = vi.spyOn(store, 'put')

      await expect(storeUploadChunk(chunk(1, 3, '0123456789', { maxTotalBytes: 15 }), neverFinishes())).rejects.toMatchObject({
        name: 'UploadTooLargeError', size: 20, maxBytes: 15,
      })

      expect(put).not.toHaveBeenCalled()
      expect(await storedKeys()).toEqual([])
      expect(await manifest()).toEqual({ state: 'ended' })

      // Later chunks are refused like any others once it ended, even one that would fit.
      await expect(storeUploadChunk(chunk(2, 3, 'x', { maxTotalBytes: 15 }), neverFinishes())).rejects.toThrow('already ended')
      expect(put).not.toHaveBeenCalled()
      await expectANewUploadWorks()
    })

    it('counts every chunk so far, across many', async () => {
      for (let i = 0; i < 4; i++) await storeUploadChunk(chunk(i, 5, '12345', { maxTotalBytes: 20 }), neverFinishes())
      await expect(storeUploadChunk(chunk(4, 5, 'x', { maxTotalBytes: 20 }), neverFinishes())).rejects.toMatchObject({ size: 21 })
    })

    it('refuses a first chunk over it outright', async () => {
      const put = vi.spyOn(store, 'put')
      await expect(storeUploadChunk(chunk(0, 2, '0123456789', { maxTotalBytes: 5 }), neverFinishes())).rejects.toBeInstanceOf(UploadTooLargeError)
      expect(put).not.toHaveBeenCalled()
      await expect(storeUploadChunk(chunk(0, 2, 'x', { maxTotalBytes: 5 }), neverFinishes())).rejects.toThrow('already ended')
    })

    it('accepts an upload of exactly the cap', async () => {
      await storeUploadChunk(chunk(0, 2, '01234', { maxTotalBytes: 10 }), neverFinishes())
      const result = await storeUploadChunk(chunk(1, 2, '56789', { maxTotalBytes: 10 }), finishReading())
      expect(result).toMatchObject({ status: 'finished' })
    })
  })

  describe('a crash during finish', () => {
    /** A `finish` that had its file written and then does nothing more until the test lets it. */
    function finishSpooled() {
      const entered = deferred<string>()
      const gate = deferred()
      const finish = async ({ toFile }: AssembledUpload) => {
        entered.resolve(await toFile())
        await gate.promise
        return 'done'
      }
      return { finish, entered, gate }
    }

    it('leaves finalizing until expiry, with everything kept, and then the sweep cleans up', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const { finish, entered, gate } = finishSpooled()
      // As good as dead: it does nothing more until the end of this test.
      const dead = storeUploadChunk(chunk(1, 2, 'b'), finish)
      const filePath = await entered.promise
      const longAgo = new Date(T0 - 2 * HOUR)
      await fs.promises.utimes(filePath, longAgo, longAgo)

      // However old they look, nothing goes while it is finalizing, and nobody takes over.
      await cleanupStaleTempUploads(1, Date.now() + 1000)
      expect(await storedKeys()).toHaveLength(2)
      expect(fs.existsSync(filePath)).toBe(true)
      const other = neverFinishes()
      await expect(storeUploadChunk(chunk(1, 2, 'b'), other)).rejects.toThrow('being processed')
      expect(other).not.toHaveBeenCalled()

      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      expect(await manifest()).toBeUndefined()
      await cleanupStaleTempUploads(HOUR)
      expect(await storedKeys()).toEqual([])
      expect(fs.existsSync(filePath)).toBe(false)

      // And if it was only asleep, it brings nothing back.
      gate.resolve()
      await expect(dead).resolves.toEqual({ status: 'finished', result: 'done' })
      expect(await manifest()).toBeUndefined()
    })

    it('errors the stream of a `finish` that outlives the manifest once the sweep has been', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      const { finish, entered, gate } = finishGated()
      const slow = storeUploadChunk(chunk(1, 2, 'b'), finish)
      await entered.promise

      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      await cleanupStaleTempUploads(HOUR)
      expect(await storedKeys()).toEqual([])

      gate.resolve()
      await expect(slow).rejects.toThrow('Upload chunk 0 is missing')
      expect(await manifest()).toBeUndefined()
    })

    it('does not end an upload that started again under its id when it finishes late', async () => {
      const { finish, entered, gate } = finishGated()
      const slow = storeUploadChunk(chunk(0, 1, 'old'), finish)
      await entered.promise
      advance(UPLOAD_IDLE_EXPIRY_MS + 1)
      await storeUploadChunk(chunk(0, 2, 'new'), neverFinishes())
      const before = await manifest()

      gate.resolve()
      await expect(slow).resolves.toEqual({ status: 'finished', result: 'old' })

      expect(await manifest()).toEqual(before)
      await expect(storeUploadChunk(chunk(1, 2, '!'), finishReading())).resolves.toEqual({ status: 'finished', result: 'new!' })
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
          if (done) return { text, closed: true, error: null as unknown }
          text += decoder.decode(value)
        } catch (error) {
          return { text, closed: false, error }
        }
      }
    }

    it('reads the chunks in order, opening each only when the one before it has been read', async () => {
      await storeUploadChunk(chunk(0, 3, 'aa'), neverFinishes())
      await storeUploadChunk(chunk(1, 3, 'bb'), neverFinishes())
      const opened = vi.spyOn(store, 'stream')
      const seen: { text: string; opened: number; openedAfterAWhile: number }[] = []
      let openedByTheStreamAlone = -1

      await storeUploadChunk(chunk(2, 3, 'cc'), async ({ stream, size }) => {
        expect(size).toBe(6)
        const reader = stream().getReader()
        await tick()
        openedByTheStreamAlone = opened.mock.calls.length
        for (;;) {
          const { done, value } = await reader.read()
          if (done) return null
          const openedNow = opened.mock.calls.length
          // Time to read ahead, for a stream that would.
          await tick()
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
      expect(result).toEqual({ status: 'finished', result: 'hello world' })
    })

    it('writes no file when only the stream is used', async () => {
      const assembledDir = path.join(tempUploadsDir, 'assembled')
      let duringFinish = true
      await storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
        await readAll(stream())
        duringFinish = fs.existsSync(assembledDir)
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
      })
      expect(opened).toHaveBeenCalledTimes(2)
      expect(path.dirname(filePath)).toBe(path.join(tempUploadsDir, 'assembled'))
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('removes the file when `finish` throws', async () => {
      let filePath = ''
      await expect(storeUploadChunk(chunk(0, 1, 'a'), async ({ toFile }) => {
        filePath = await toFile()
        throw new Error('work failed')
      })).rejects.toThrow('work failed')
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it('leaves a file the consumer moved alone', async () => {
      const moved = path.join(tmpRoot, 'moved')
      const result = await storeUploadChunk(chunk(0, 1, 'x'), async ({ toFile }) => {
        await fs.promises.rename(await toFile(), moved)
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
        ['shorter than its manifest size', () => blobStream('x'), 'its manifest says 2', 'x'],
        ['empty', () => blobStream(''), 'its manifest says 2', ''],
        ['longer than its manifest size', () => blobStream('xxx'), 'over the 2 bytes', ''],
        ['missing', () => null, 'is missing', ''],
        ['unreadable from the start', unreadable, 'store went away', ''],
        ['unreadable partway', halfThenUnreadable, 'store went away', 'x'],
      ])('errors the stream when the chunk is %s, and that ends the attempt', async (_how, source, message, partial) => {
        await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
        const realStream = store.stream.bind(store)
        let calls = 0
        const opened = vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === broken ? source() : realStream(key)))
        let drained: Awaited<ReturnType<typeof drain>> | null = null

        await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
          drained = await drain(stream())
          if (drained.error) throw drained.error
        })).rejects.toThrow(message)

        expect(drained!.closed).toBe(false)
        expect(drained!.text).toBe(before + partial)
        // Reading stopped there.
        expect(calls).toBe(broken + 1)
        expect(await manifest()).toEqual({ state: 'ended' })
        expect(await storedKeys()).toEqual([])
        opened.mockRestore()
        await expect(storeUploadChunk(chunk(1, 2, 'bb'), neverFinishes())).rejects.toThrow('already ended')
        await expectANewUploadWorks()
      })

      it('errors the stream when the store cannot open the chunk', async () => {
        await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
        const realStream = store.stream.bind(store)
        let calls = 0
        vi.spyOn(store, 'stream').mockImplementation(async (key) => {
          if (calls++ === broken) throw new Error('store unavailable')
          return realStream(key)
        })
        await expect(storeUploadChunk(chunk(1, 2, 'bb'), finishReading())).rejects.toThrow('store unavailable')
        expect(await manifest()).toEqual({ state: 'ended' })
      })
    })

    it('closes a chunk that turned out too long', async () => {
      const cancelled = vi.fn()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('too long'))
        },
        cancel: cancelled,
      }))
      await expect(storeUploadChunk(chunk(0, 1, 'a'), finishReading())).rejects.toThrow('over the 1 bytes')
      expect(cancelled).toHaveBeenCalledOnce()
    })

    it('errors the stream when a chunk really has gone from the store', async () => {
      await storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await store.delete((await storedKeys())[0]!)
      await expect(storeUploadChunk(chunk(1, 2, 'b'), finishReading())).rejects.toThrow('Upload chunk 0 is missing')
    })

    it('errors `toFile` as well, and removes the part it wrote', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const realStream = store.stream.bind(store)
      let calls = 0
      vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === 1 ? blobStream('x') : realStream(key)))

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ toFile }) => {
        await toFile()
      })).rejects.toThrow('its manifest says 2')

      expect(await fs.promises.readdir(path.join(tempUploadsDir, 'assembled'))).toEqual([])
    })

    it('closes what a consumer was reading when it gives up', async () => {
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const cancelled = vi.fn()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('a'))
        },
        cancel: cancelled,
      }))

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), async ({ stream }) => {
        const reader = stream().getReader()
        await reader.read()
        await reader.cancel(new Error('the destination refused it'))
        return 'its own answer'
      })).resolves.toEqual({ status: 'finished', result: 'its own answer' })

      expect(cancelled).toHaveBeenCalledOnce()
    })

    it('lets a consumer give up while a read is waiting', async () => {
      const cancelled = vi.fn()
      vi.spyOn(store, 'stream').mockImplementationOnce(async () => new ReadableStream<Uint8Array>({ cancel: cancelled }))

      await expect(storeUploadChunk(chunk(0, 1, 'a'), async ({ stream }) => {
        const reader = stream().getReader()
        const waiting = reader.read()
        // Let it open the chunk it will wait on.
        await tick()
        await reader.cancel()
        await waiting
        await tick()
        return 'its own answer'
      })).resolves.toEqual({ status: 'finished', result: 'its own answer' })

      expect(cancelled).toHaveBeenCalledOnce()
    })

    it('closes a chunk that opens after the consumer gave up', async () => {
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
      })
    })

    it('fails the write of a consumer writing from the stream, and leaves nothing at the destination', async () => {
      const workspace = path.join(tmpRoot, 'workspace')
      const files = new LocalFileOps(() => workspace)
      await fs.promises.mkdir(path.join(workspace, 'uploads'), { recursive: true })
      const write = async ({ stream }: AssembledUpload) => (await files.write('uploads/report.bin', stream())).size
      await storeUploadChunk(chunk(0, 2, 'aa'), neverFinishes())
      const realStream = store.stream.bind(store)
      let calls = 0
      const opened = vi.spyOn(store, 'stream').mockImplementation(async (key) => (calls++ === 1 ? blobStream('b') : realStream(key)))

      await expect(storeUploadChunk(chunk(1, 2, 'bb'), write)).rejects.toThrow('its manifest says 2')

      expect(await fs.promises.readdir(path.join(workspace, 'uploads'))).toEqual([])

      opened.mockRestore()
      await storeUploadChunk(chunk(0, 2, 'aa', { uploadId: NEW_UPLOAD_ID }), neverFinishes())
      await expect(storeUploadChunk(chunk(1, 2, 'bb', { uploadId: NEW_UPLOAD_ID }), write)).resolves.toEqual({ status: 'finished', result: 4 })
      expect(await fs.promises.readFile(path.join(workspace, 'uploads', 'report.bin'), 'utf8')).toBe('aabb')
    })

    it('keeps what was at the destination when the stream errors', async () => {
      const workspace = path.join(tmpRoot, 'workspace')
      const files = new LocalFileOps(() => workspace)
      await fs.promises.mkdir(path.join(workspace, 'uploads'), { recursive: true })
      await fs.promises.writeFile(path.join(workspace, 'uploads', 'report.bin'), 'older')
      vi.spyOn(store, 'stream').mockResolvedValueOnce(blobStream('aaaa'))

      await expect(storeUploadChunk(chunk(0, 1, 'aa'), async ({ stream }) => {
        await files.write('uploads/report.bin', stream())
      })).rejects.toThrow('over the 2 bytes')

      expect(await fs.promises.readFile(path.join(workspace, 'uploads', 'report.bin'), 'utf8')).toBe('older')
      expect(await fs.promises.readdir(path.join(workspace, 'uploads'))).toEqual(['report.bin'])
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
      await expect(storeUploadChunk(chunk(2, 3, 'c'), finishReading())).resolves.toEqual({ status: 'finished', result: 'abc' })
    })

    it('keeps the bytes of the attempt holding the write slot, however old they look', async () => {
      const inFlight = holdNextPut()
      const write = storeUploadChunk(chunk(0, 2, 'a'), neverFinishes())
      await inFlight.stored.promise

      await cleanupStaleTempUploads(1, Date.now() + 1000)

      expect(await storedKeys()).toHaveLength(1)
      inFlight.gate.resolve()
      await expect(write).resolves.toEqual({ status: 'received' })
    })

    it('keeps the chunks of a running finish, however old they look', async () => {
      const { finish, entered, gate } = finishGated()
      const request = storeUploadChunk(chunk(0, 1, 'a'), finish)
      await entered.promise

      await cleanupStaleTempUploads(1, Date.now() + 1000)

      expect(await storedKeys()).toHaveLength(1)
      gate.resolve()
      await expect(request).resolves.toEqual({ status: 'finished', result: 'a' })
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

    it('removes old bytes a live manifest does not name, and only those', async () => {
      const late = holdNextPut()
      const write = storeUploadChunk(chunk(0, 2, 'old'), neverFinishes())
      await late.stored.promise
      advance(UPLOAD_IDLE_EXPIRY_MS)
      await storeUploadChunk(chunk(0, 2, 'new'), neverFinishes())
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('store unavailable'))
      late.gate.resolve()
      await expect(write).rejects.toBeInstanceOf(UploadConflictError)
      expect(await storedKeys()).toHaveLength(2)
      advance(1)

      await cleanupStaleTempUploads(HOUR)

      expect(await storedKeys()).toHaveLength(1)
      await expect(storeUploadChunk(chunk(1, 2, '!'), finishReading())).resolves.toEqual({ status: 'finished', result: 'new!' })
    })

    it('removes bytes an ended upload could not delete, while it stays ended', async () => {
      vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('store unavailable'))
      await storeUploadChunk(chunk(0, 1, 'a'), finishReading())
      expect(await storedKeys()).toHaveLength(1)
      advance(HOUR - 1)

      await cleanupStaleTempUploads(HOUR - 2)

      expect(await storedKeys()).toEqual([])
      await expect(storeUploadChunk(chunk(0, 1, 'a'), neverFinishes())).rejects.toThrow('already ended')
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
  const attemptId = `${T0}-11111111-1111-1111-1111-111111111111`
  const receiving = {
    target: 'agent:a',
    totalChunks: 2,
    maxBytes: 10,
    state: 'receiving',
    chunks: [{ attemptId, size: 1 }],
    writing: null,
  }

  it('reads back what it was given', () => {
    expect(uploadManifestSchema.parse(receiving)).toEqual(receiving)
    expect(uploadManifestSchema.parse({ state: 'ended' })).toEqual({ state: 'ended' })
  })

  it.each<[string, Record<string, unknown>]>([
    ['more chunks than an upload may have', { totalChunks: 201 }],
    ['an unknown state', { state: 'done' }],
    ['a chunk whose attempt is not named as one', { chunks: [{ attemptId: '../../x', size: 1 }] }],
    ['a write slot that names no attempt', { writing: '../../x' }],
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
