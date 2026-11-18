import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GZIP_LAYER, ZSTD_LAYER, compressZstd, recompressLayer, withRecompressedLayers } from '../../../../scripts/lib/zstd-layers'

const sha256 = (data: Buffer) => `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
const digest = (c: string) => `sha256:${c.repeat(64)}`

describe('compressZstd', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-frame-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  async function* chunked(data: Buffer, size: number) {
    for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
  }

  // Fed straight through a pipeline, an 8 KB input split at 7 KB came out
  // different from the same input in one piece (Node 22.23, zstd 1.5.7).
  it.each([
    ['a small layer', Buffer.from('small layer\n'.repeat(700))],
    ['a layer of many chunks', Buffer.from(crypto.randomBytes(1 << 19).toString('hex').repeat(3))],
  ])('makes the same bytes for %s however it is chunked', async (_name, data) => {
    const results = []
    for (const size of [data.length, 7000, 16384, 100_000]) {
      const target = path.join(dir, `${size}.zst`)
      results.push(await compressZstd(chunked(data, size), target))
      expect(zlib.zstdDecompressSync(fs.readFileSync(target)).equals(data)).toBe(true)
    }
    expect(new Set(results.map((r) => r.digest)).size).toBe(1)
    expect(results[0].size).toBe(fs.statSync(path.join(dir, `${data.length}.zst`)).size)
  })
})

describe('recompressLayer', () => {
  let dir: string
  // Stands in for a layer's tar: compressible, and big enough for several chunks.
  const tar = Buffer.from('agent-container layer\n'.repeat(200_000))
  const gzip = zlib.gzipSync(tar)
  const layer = { mediaType: GZIP_LAYER, digest: sha256(gzip), size: gzip.length, annotations: { 'org.example': 'kept' } }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-layers-'))
    fs.writeFileSync(path.join(dir, 'layer.gz'), gzip)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes the same tar as zstd, and describes the file it wrote', async () => {
    const target = path.join(dir, 'layer.zst')
    const result = await recompressLayer(path.join(dir, 'layer.gz'), target, layer, sha256(tar))
    const written = fs.readFileSync(target)
    expect(zlib.zstdDecompressSync(written).equals(tar)).toBe(true)
    expect(result).toEqual({ mediaType: ZSTD_LAYER, digest: sha256(written), size: written.length, annotations: { 'org.example': 'kept' } })
  })

  it('refuses a layer that does not unpack to the image config’s diff ID', async () => {
    await expect(recompressLayer(path.join(dir, 'layer.gz'), path.join(dir, 'layer.zst'), layer, digest('0')))
      .rejects.toThrow(`Layer ${layer.digest} unpacks to ${sha256(tar)}, the image config says ${digest('0')}`)
  })
})

describe('withRecompressedLayers', () => {
  it('swaps in each recompressed layer and keeps the rest of the manifest', () => {
    const manifest = {
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest('c'), size: 10 },
      layers: [
        { mediaType: GZIP_LAYER, digest: digest('1'), size: 100 },
        { mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: digest('2'), size: 200 },
        { mediaType: GZIP_LAYER, digest: digest('1'), size: 100 },
      ],
    }
    const zstd = { mediaType: ZSTD_LAYER, digest: digest('a'), size: 70 }
    expect(withRecompressedLayers(manifest, new Map([[digest('1'), zstd]]))).toEqual({
      ...manifest,
      layers: [zstd, manifest.layers[1], zstd],
    })
  })
})
