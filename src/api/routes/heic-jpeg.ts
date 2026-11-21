import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { background } from '@shared/lib/background'
import { captureException } from '@shared/lib/error-reporting'
import { HEIC_PREVIEW_MAX_SOURCE_BYTES } from '@shared/lib/utils/heic-preview'

export const HEIC_EXTENSIONS = new Set(['.heic', '.heif'])
const HEIC_PREVIEW_MAX_PIXELS = 50_000_000
const HEIC_PREVIEW_TIMEOUT_MS = 30_000
let heicPreviewQueue: Promise<void> = Promise.resolve()

function heicPreviewWorkerUrl(): URL {
  try {
    // Electron emits CommonJS; the web build and unbundled source use ESM.
    const filename = process.versions.electron ? './heic-preview-worker.cjs' : './heic-preview-worker.mjs'
    return new URL(filename, import.meta.url)
  } catch (error) {
    throw new Error('Failed to resolve HEIC preview worker', { cause: error })
  }
}

function runHeicPreviewWorker(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const inputBuffer = input.buffer as ArrayBuffer
    const worker = new Worker(heicPreviewWorkerUrl(), {
      workerData: {
        input: inputBuffer,
        maxPixels: HEIC_PREVIEW_MAX_PIXELS,
        quality: 85,
      },
      transferList: [inputBuffer],
      resourceLimits: {
        maxOldGenerationSizeMb: 384,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 4,
      },
    })
    let settled = false
    let timedOut = false
    let workerError: Error | undefined
    let result: { output?: ArrayBuffer; error?: string } | undefined
    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      background(worker.terminate().catch((error) => {
        if (settled) return
        settled = true
        reject(error)
      }), { name: 'heic-preview.terminate-worker' })
    }, HEIC_PREVIEW_TIMEOUT_MS)

    worker.once('message', (message: { output?: ArrayBuffer; error?: string }) => {
      result = message
    })
    worker.once('error', (error) => {
      workerError = error
    })
    worker.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (timedOut) reject(new Error('HEIC preview conversion timed out'))
      else if (workerError) reject(workerError)
      else if (code !== 0) reject(new Error(`HEIC preview worker exited with code ${code}`))
      else if (result?.error) reject(new Error(result.error))
      else if (result?.output) resolve(new Uint8Array(result.output))
      else reject(new Error('HEIC preview worker returned no image'))
    })
  })
}

function queueHeicPreview<T>(task: () => Promise<T>): Promise<T> {
  const queued = heicPreviewQueue.then(task)
  heicPreviewQueue = queued.then(() => undefined, () => undefined)
  return queued
}

/**
 * Turns a HEIC or HEIF file into JPEG bytes. Desktop and the Node host decode it in a worker
 * thread. A deployment that cannot start worker threads passes its own converter to
 * `setImageConverter` at boot.
 */
export interface ImageConverter {
  /** The first image of `input` as a JPEG. It takes `input`, so the caller must not use it afterwards. */
  heicToJpeg(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
}

const workerThreadConverter: ImageConverter = {
  heicToJpeg: (input) => queueHeicPreview(() => runHeicPreviewWorker(input)),
}
let currentConverter: ImageConverter = workerThreadConverter

/** Set once at boot by a deployment with its own converter. A test passes null to go back to the worker thread. */
export function setImageConverter(converter: ImageConverter | null): void {
  currentConverter = converter ?? workerThreadConverter
}

export function heicToJpeg(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return currentConverter.heicToJpeg(input)
}

/** The agent's Read opens JPEG but not HEIC, so a HEIC someone sends is saved as a JPEG. */
export async function heicUploadAsJpeg(name: string, source: Blob | Uint8Array): Promise<{ name: string; data: Uint8Array<ArrayBuffer> } | undefined> {
  const extension = path.extname(name)
  const size = source instanceof Uint8Array ? source.byteLength : source.size
  if (!HEIC_EXTENSIONS.has(extension.toLowerCase()) || size > HEIC_PREVIEW_MAX_SOURCE_BYTES) return undefined
  try {
    // The converter takes the buffer it is given, so it gets a copy and the caller keeps the original.
    const input = new Uint8Array(source instanceof Uint8Array ? source : await source.arrayBuffer())
    const data = await heicToJpeg(input)
    return { name: `${name.slice(0, -extension.length)}.jpg`, data }
  } catch (error) {
    captureException(error, { tags: { component: 'agents', operation: 'heic-upload-as-jpeg' } })
    return undefined
  }
}
