// Recompresses an image's gzip layers as zstd, for scripts/fetch-agent-image.ts.
// The bundled image shrinks by about a quarter (0.6.0's: 733 → 543 MiB), which
// keeps the macOS update zip under 1 GiB: Gamut 0.5.47 and older (Electron 41)
// download an update into one buffer that can't grow past that. containerd
// reads zstd layers (since 1.5), and only Lima loads the archive.
import crypto from 'crypto'
import fs from 'fs'
import zlib from 'zlib'
import { pipeline } from 'stream/promises'
import type { Descriptor, ImageManifest } from './oci-image'

export const GZIP_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip'
export const ZSTD_LAYER = 'application/vnd.oci.image.layer.v1.tar+zstd'

// Single-threaded: Node 22's zstd fails with workers (ERR_STREAM_PUSH_AFTER_EOF),
// and fetch-agent-image.ts runs layers side by side instead.
const ZSTD_LEVEL = 19

/** Node 22.15 and later have zstd. */
export function zstdAvailable(): boolean {
  return typeof zlib.createZstdCompress === 'function'
}

/** Passes chunks through, adding each to `hash` and its length to `count.bytes`. */
function tap(hash: crypto.Hash, count = { bytes: 0 }) {
  return async function* (source: AsyncIterable<Buffer>) {
    for await (const chunk of source) {
      hash.update(chunk)
      count.bytes += chunk.length
      yield chunk
    }
  }
}

/**
 * Writes `chunks` to `target` as one zstd frame and returns its digest and size.
 * The same data makes the same bytes however it is chunked, so a layer that
 * didn't change makes the same blob, and an app update doesn't download it again.
 * That takes care: Node compresses a chunk that reaches its zstd stream after
 * end() with zstd's end flag, and zstd compresses what it sees whole in one call
 * differently. So each chunk is compressed before the next goes in, and the
 * frame ends after the last.
 */
export async function compressZstd(chunks: AsyncIterable<Buffer>, target: string): Promise<{ digest: string; size: number }> {
  const hash = crypto.createHash('sha256')
  const count = { bytes: 0 }
  const zstd = zlib.createZstdCompress({ params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
  const written = pipeline(zstd, tap(hash, count), fs.createWriteStream(target))
  // Awaited below; this only keeps a failure before then from going unhandled.
  written.catch(() => {})
  try {
    for await (const chunk of chunks) {
      await new Promise<void>((resolve, reject) => zstd.write(chunk, (error) => (error ? reject(error) : resolve())))
    }
    zstd.end()
  } catch (error) {
    zstd.destroy(error as Error)
    throw error
  }
  await written
  return { digest: `sha256:${hash.digest('hex')}`, size: count.bytes }
}

/**
 * Writes the gzip layer at `source` to `target` as zstd, checking that it
 * unpacks to `diffId` (the image config's digest of the uncompressed tar), and
 * returns the new layer's descriptor.
 */
export async function recompressLayer(source: string, target: string, layer: Descriptor, diffId: string): Promise<Descriptor> {
  const tar = crypto.createHash('sha256')
  const gunzip = zlib.createGunzip()
  const read = fs.createReadStream(source)
  read.on('error', (error) => gunzip.destroy(error))
  read.pipe(gunzip)
  const compressed = await compressZstd(tap(tar)(gunzip), target)
  const unpacked = `sha256:${tar.digest('hex')}`
  if (unpacked !== diffId) throw new Error(`Layer ${layer.digest} unpacks to ${unpacked}, the image config says ${diffId}`)
  return { ...layer, mediaType: ZSTD_LAYER, ...compressed }
}

/** The manifest with each recompressed layer in place of its gzip original. */
export function withRecompressedLayers(manifest: ImageManifest, recompressed: Map<string, Descriptor>): ImageManifest {
  return { ...manifest, layers: manifest.layers.map((layer) => recompressed.get(layer.digest) ?? layer) }
}
