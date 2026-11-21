import { Worker } from 'node:worker_threads'
import { background } from '@shared/lib/background'

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

/** Decodes one HEIC at a time, each in its own worker thread. */
export function heicToJpegInWorkerThread(input: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return queueHeicPreview(() => runHeicPreviewWorker(input))
}
