import decodeHeic from 'heic-decode'
import jpeg from 'jpeg-js'
import { parentPort, workerData } from 'node:worker_threads'

async function main() {
  let images
  try {
    images = await decodeHeic.all({ buffer: new Uint8Array(workerData.input) })
    const image = images[0]
    if (!image) throw new Error('HEIC image not found')
    const pixels = image.width * image.height
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > workerData.maxPixels) {
      throw new Error('HEIC image dimensions exceed the preview limit')
    }
    const decoded = await image.decode()
    const encoded = jpeg.encode(decoded, workerData.quality).data
    const output = Uint8Array.from(encoded)
    parentPort.postMessage({ output: output.buffer }, [output.buffer])
  } catch (error) {
    parentPort.postMessage({ error: error instanceof Error ? error.message : 'HEIC conversion failed' })
  } finally {
    images?.dispose?.()
    parentPort.close()
  }
}

main().catch((error) => {
  parentPort.postMessage({ error: error instanceof Error ? error.message : 'HEIC conversion failed' })
  parentPort.close()
})
