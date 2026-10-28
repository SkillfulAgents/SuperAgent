// Download the agent image this version of the app runs (getDefaultAgentImage())
// for one architecture, as an OCI image-layout tar that ships in the app. The
// app loads it into the container runtime instead of pulling it, so a new
// install starts its first agent without a second download.
//
// Plain HTTPS and no Docker: CI's macOS runners have neither a Docker daemon
// nor a VM to run one in. Every blob is checked against its digest and size.
// The gzip layers are recompressed as zstd (scripts/lib/zstd-layers.ts), which
// needs Node 22.15 or later; the image config, and so the image ID, is unchanged.
//
// Usage: tsx scripts/fetch-agent-image.ts <out-dir> [arch: arm64|amd64] [image]
//   arch defaults to this machine's (like download-lima.sh), image to the one
//   package.json's version runs.
//   AGENT_IMAGE_REQUIRED=true makes a missing image an error (the release
//   build, and dist:mas unless it is set to false); otherwise it warns and
//   bundles nothing, and the app pulls as before.
//
// Output: <out-dir>/agent-image.tar and <out-dir>/agent-image.json
// (src/shared/lib/container/bundled-agent-image-schema.ts). Like
// download-lima.sh, every run downloads afresh, so a damaged leftover never ships.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { once } from 'events'
import {
  INDEX_MEDIA_TYPES,
  MANIFEST_MEDIA_TYPES,
  TAR_END,
  blobPath,
  layoutMetadata,
  parseBearerChallenge,
  parseImageRef,
  selectPlatformManifest,
  tarHeader,
  tarPadding,
  type Descriptor,
  type ImageManifest,
} from './lib/oci-image'
import {
  BUNDLED_AGENT_IMAGE_ARCHIVE,
  BUNDLED_AGENT_IMAGE_MANIFEST,
  bundledAgentImageSchema,
  type BundledAgentImage,
} from '../src/shared/lib/container/bundled-agent-image-schema'
import { GZIP_LAYER, recompressLayer, withRecompressedLayers, zstdAvailable } from './lib/zstd-layers'
import { agentImageForVersion } from '../src/shared/lib/config/version'
import pkg from '../package.json'

class ImageNotFoundError extends Error {}

class Registry {
  private token: string | null = null

  constructor(private readonly host: string, private readonly repository: string) {}

  /** GET a registry path, answering a Bearer challenge once (anonymous pull token). */
  async get(pathname: string, accept?: string[]): Promise<Response> {
    const url = `https://${this.host}/v2/${this.repository}/${pathname}`
    const headers = (): Record<string, string> => ({
      ...(accept ? { Accept: accept.join(', ') } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    })
    let res = await fetchWithRetry(url, headers())
    if (res.status === 401 && !this.token) {
      const challenge = parseBearerChallenge(res.headers.get('www-authenticate') ?? '')
      if (!challenge) throw new Error(`${url}: 401 without a Bearer challenge`)
      const tokenUrl = new URL(challenge.realm)
      if (challenge.service) tokenUrl.searchParams.set('service', challenge.service)
      tokenUrl.searchParams.set('scope', challenge.scope ?? `repository:${this.repository}:pull`)
      const tokenRes = await fetchWithRetry(tokenUrl.toString(), {})
      if (!tokenRes.ok) throw new Error(`Token request failed: HTTP ${tokenRes.status}`)
      const body = (await tokenRes.json()) as { token?: string; access_token?: string }
      this.token = body.token ?? body.access_token ?? null
      if (!this.token) throw new Error('Token response carried no token')
      res = await fetchWithRetry(url, headers())
    }
    if (res.status === 404) throw new ImageNotFoundError(`${url}: not found`)
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
    return res
  }
}

async function fetchWithRetry(url: string, headers: Record<string, string>, attempts = 3): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers })
      if (res.status >= 500 && attempt < attempts) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Request failed after ${attempts} attempts: ${url}: ${(error as Error).message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

function sha256(data: Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`
}

/** Fetch a manifest by digest and check the bytes are the ones the digest names. */
async function fetchManifest(registry: Registry, descriptor: Descriptor): Promise<Buffer> {
  const body = Buffer.from(await (await registry.get(`manifests/${descriptor.digest}`, MANIFEST_MEDIA_TYPES)).arrayBuffer())
  if (sha256(body) !== descriptor.digest) throw new Error(`Manifest ${descriptor.digest} doesn't match its digest`)
  return body
}

/** Stream a blob to `file`, checking its size and digest; retried as a whole. */
async function downloadBlob(registry: Registry, descriptor: Descriptor, file: string, attempts = 3): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await registry.get(`blobs/${descriptor.digest}`)
      const hash = crypto.createHash('sha256')
      const out = fs.createWriteStream(file)
      let bytes = 0
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        bytes += chunk.length
        if (!out.write(chunk)) await once(out, 'drain')
      }
      out.end()
      await once(out, 'finish')
      const digest = `sha256:${hash.digest('hex')}`
      if (bytes !== descriptor.size) throw new Error(`${descriptor.digest} is ${bytes} bytes, the manifest says ${descriptor.size}`)
      if (digest !== descriptor.digest) throw new Error(`${descriptor.digest} downloaded as ${digest}`)
      return
    } catch (error) {
      if (attempt >= attempts || error instanceof ImageNotFoundError) throw error
      console.warn(`  retrying ${descriptor.digest.slice(7, 19)}: ${(error as Error).message}`)
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

/**
 * Recompress the manifest's gzip layers as zstd, biggest first and four at a
 * time, each into `blobDir` under its new digest. Keyed by the old digest.
 */
async function recompressGzipLayers(manifest: ImageManifest, diffIds: string[], blobDir: string): Promise<Map<string, Descriptor>> {
  if (diffIds.length !== manifest.layers.length) {
    throw new Error(`The image config lists ${diffIds.length} layers, the manifest ${manifest.layers.length}`)
  }
  const queue = [...new Map(manifest.layers.map((layer, i) => [layer.digest, { layer, diffId: diffIds[i] }])).values()]
    .filter(({ layer }) => layer.mediaType === GZIP_LAYER)
    .sort((a, b) => b.layer.size - a.layer.size)
  const recompressed = new Map<string, Descriptor>()
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const source = path.join(blobDir, next.layer.digest.slice(7))
      const partial = `${source}.zst`
      const layer = await recompressLayer(source, partial, next.layer, next.diffId)
      fs.renameSync(partial, path.join(blobDir, layer.digest.slice(7)))
      recompressed.set(next.layer.digest, layer)
    }
  }))
  return recompressed
}

async function writeEntry(out: fs.WriteStream, name: string, size: number, body: Buffer | string | null): Promise<void> {
  const write = async (chunk: Buffer) => {
    if (!out.write(chunk)) await once(out, 'drain')
  }
  await write(tarHeader(name, size, body === null ? 'directory' : 'file'))
  if (typeof body === 'string') {
    for await (const chunk of fs.createReadStream(body)) await write(chunk as Buffer)
  } else if (body) {
    await write(body)
  }
  await write(tarPadding(size))
}

async function main(): Promise<void> {
  const [outDir, archArg, imageArg] = process.argv.slice(2)
  if (!outDir) {
    console.error('Usage: tsx scripts/fetch-agent-image.ts <out-dir> [arm64|amd64] [image]')
    process.exit(2)
  }
  const arch = archArg ?? (process.arch === 'x64' ? 'amd64' : process.arch)
  const image = imageArg ?? agentImageForVersion(pkg.version)
  const required = process.env.AGENT_IMAGE_REQUIRED === 'true'
  const ref = parseImageRef(image)
  const registry = new Registry(ref.registry, ref.repository)

  let platformManifest: Descriptor
  try {
    const res = await registry.get(`manifests/${ref.tag}`, [...INDEX_MEDIA_TYPES, ...MANIFEST_MEDIA_TYPES])
    const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]
    if (!INDEX_MEDIA_TYPES.includes(mediaType)) throw new Error(`${image} is a ${mediaType}, not a multi-platform index`)
    platformManifest = selectPlatformManifest((await res.json()) as { manifests?: Descriptor[] }, arch)
  } catch (error) {
    if (error instanceof ImageNotFoundError && !required) {
      console.warn(`WARNING: ${image} isn't published yet; the app will pull it instead of loading a bundled copy.`)
      fs.rmSync(outDir, { recursive: true, force: true })
      return
    }
    throw error
  }

  fs.rmSync(outDir, { recursive: true, force: true })
  const blobDir = path.join(outDir, '.blobs')
  fs.mkdirSync(blobDir, { recursive: true })

  const manifestBody = await fetchManifest(registry, platformManifest)
  const manifest = JSON.parse(manifestBody.toString('utf8')) as ImageManifest
  // Each blob once (layers can repeat), base layers first: they change least,
  // so an update's archive shares its longest stretch with the last one.
  const blobs = [...new Map([...manifest.layers, manifest.config].map((d) => [d.digest, d])).values()]
  const queue = [...blobs]
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let blob = queue.shift(); blob; blob = queue.shift()) {
      await downloadBlob(registry, blob, path.join(blobDir, blob.digest.slice(7)))
    }
  }))

  let recompressed = new Map<string, Descriptor>()
  if (zstdAvailable()) {
    const config = JSON.parse(fs.readFileSync(path.join(blobDir, manifest.config.digest.slice(7)), 'utf8')) as { rootfs?: { diff_ids?: string[] } }
    recompressed = await recompressGzipLayers(manifest, config.rootfs?.diff_ids ?? [], blobDir)
  } else if (required) {
    throw new Error(`Node ${process.version} has no zstd (22.15 and later do), and the bundled image must be zstd to keep the macOS update under 1 GiB`)
  } else {
    console.warn(`WARNING: Node ${process.version} has no zstd (22.15 and later do), so the bundled image keeps its gzip layers.`)
  }
  const archived = withRecompressedLayers(manifest, recompressed)
  const archivedBody = recompressed.size > 0 ? Buffer.from(JSON.stringify(archived)) : manifestBody
  const archivedManifest: Descriptor = { ...platformManifest, digest: sha256(archivedBody), size: archivedBody.length }
  const archivedBlobs = [...new Map([...archived.layers, archived.config].map((d) => [d.digest, d])).values()]

  const archive = path.join(outDir, BUNDLED_AGENT_IMAGE_ARCHIVE)
  const partial = `${archive}.partial`
  const out = fs.createWriteStream(partial)
  for (const dir of ['blobs/', 'blobs/sha256/']) await writeEntry(out, dir, 0, null)
  for (const blob of archivedBlobs) await writeEntry(out, blobPath(blob.digest), blob.size, path.join(blobDir, blob.digest.slice(7)))
  await writeEntry(out, blobPath(archivedManifest.digest), archivedBody.length, archivedBody)
  for (const file of layoutMetadata(image, archivedManifest, archived)) await writeEntry(out, file.name, file.body.length, file.body)
  out.end(TAR_END)
  await once(out, 'finish')
  fs.renameSync(partial, archive)
  fs.rmSync(blobDir, { recursive: true, force: true })

  const description: BundledAgentImage = bundledAgentImageSchema.parse({
    image,
    architecture: arch,
    manifestDigest: platformManifest.digest,
    archiveBytes: fs.statSync(archive).size,
  })
  // Written last: a description means a whole archive.
  fs.writeFileSync(path.join(outDir, BUNDLED_AGENT_IMAGE_MANIFEST), JSON.stringify(description, null, 2) + '\n')
  console.log(`  agent-image: ${image} (${arch}), ${manifest.layers.length} layers (${recompressed.size} recompressed as zstd), ${(description.archiveBytes / 1048576).toFixed(1)} MiB`)
}

main().catch((error) => {
  console.error(`ERROR: ${(error as Error).message}`)
  process.exit(1)
})
