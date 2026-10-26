// Pure helpers for scripts/fetch-agent-image.ts: read an image reference and a
// registry's answers, and lay the image out as an OCI image-layout tar, the
// format `nerdctl load` and `docker load` read (the same one `docker save`
// writes since Docker 25: an OCI layout plus Docker's manifest.json).

export interface ImageRef {
  /** Registry host, e.g. ghcr.io */
  registry: string
  /** Repository path, e.g. skillfulagents/superagent-agent-container-base */
  repository: string
  /** Tag, e.g. 0.5.49 */
  tag: string
}

/** Parse `registry/repository:tag`. The registry must be explicit: the app never runs a Docker Hub image. */
export function parseImageRef(ref: string): ImageRef {
  const m = /^([a-z0-9.-]+\.[a-z]+(?::\d+)?)\/([a-z0-9._/-]+):([\w][\w.-]{0,127})$/.exec(ref)
  if (!m) throw new Error(`Not a registry/repository:tag image reference: ${ref}`)
  return { registry: m[1], repository: m[2], tag: m[3] }
}

export interface BearerChallenge {
  realm: string
  service?: string
  scope?: string
}

/** Parse a registry's `WWW-Authenticate: Bearer realm="…",service="…",scope="…"`. */
export function parseBearerChallenge(header: string): BearerChallenge | null {
  if (!/^Bearer\s/i.test(header)) return null
  const params = new Map<string, string>()
  for (const m of header.slice(header.indexOf(' ') + 1).matchAll(/(\w+)="([^"]*)"/g)) params.set(m[1], m[2])
  const realm = params.get('realm')
  if (!realm) return null
  return { realm, service: params.get('service'), scope: params.get('scope') }
}

export interface Descriptor {
  mediaType: string
  digest: string
  size: number
  platform?: { os: string; architecture: string; variant?: string }
  annotations?: Record<string, string>
}

export const INDEX_MEDIA_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]

export const MANIFEST_MEDIA_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]

/** The linux image for `architecture` in a multi-platform index (skipping build attestations, platform unknown/unknown). */
export function selectPlatformManifest(index: { manifests?: Descriptor[] }, architecture: string): Descriptor {
  const match = (index.manifests ?? []).filter(
    (m) => m.platform?.os === 'linux' && m.platform.architecture === architecture && MANIFEST_MEDIA_TYPES.includes(m.mediaType)
  )
  if (match.length !== 1) {
    const found = (index.manifests ?? []).map((m) => `${m.platform?.os}/${m.platform?.architecture}`).join(', ')
    throw new Error(`Expected one linux/${architecture} image in the index, found ${match.length} (${found})`)
  }
  return match[0]
}

export interface ImageManifest {
  mediaType?: string
  config: Descriptor
  layers: Descriptor[]
}

/** The blob path a descriptor lives at inside the layout. */
export function blobPath(digest: string): string {
  const m = /^sha256:([0-9a-f]{64})$/.exec(digest)
  if (!m) throw new Error(`Unsupported digest: ${digest}`)
  return `blobs/sha256/${m[1]}`
}

/**
 * The small files of the layout: index.json names the image the way
 * containerd and Docker read a name from `docker save` output, and
 * manifest.json is Docker's own listing, for a Docker daemon that reads only that.
 */
export function layoutMetadata(image: string, manifest: Descriptor, parsed: ImageManifest): { name: string; body: Buffer }[] {
  const { tag } = parseImageRef(image)
  const index = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [
      {
        mediaType: manifest.mediaType,
        digest: manifest.digest,
        size: manifest.size,
        annotations: {
          'io.containerd.image.name': image,
          'org.opencontainers.image.ref.name': tag,
        },
      },
    ],
  }
  const dockerManifest = [
    {
      Config: blobPath(parsed.config.digest),
      RepoTags: [image],
      Layers: parsed.layers.map((layer) => blobPath(layer.digest)),
    },
  ]
  return [
    { name: 'oci-layout', body: Buffer.from(JSON.stringify({ imageLayoutVersion: '1.0.0' })) },
    { name: 'index.json', body: Buffer.from(JSON.stringify(index)) },
    { name: 'manifest.json', body: Buffer.from(JSON.stringify(dockerManifest)) },
  ]
}

/**
 * A ustar header for a regular file or a directory. Owner, group and mtime
 * are zero, so the same image always makes the same bytes: an app update
 * whose image didn't change then carries an identical archive.
 */
export function tarHeader(name: string, size: number, type: 'file' | 'directory' = 'file'): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`Tar entry name too long: ${name}`)
  const header = Buffer.alloc(512)
  const octal = (value: number, width: number) => value.toString(8).padStart(width - 1, '0') + '\0'
  header.write(name, 0, 100, 'utf8')
  header.write(octal(type === 'directory' ? 0o755 : 0o644, 8), 100)
  header.write(octal(0, 8), 108)
  header.write(octal(0, 8), 116)
  header.write(octal(size, 12), 124)
  header.write(octal(0, 12), 136)
  header.write('        ', 148) // checksum field counts as spaces while summing
  header.write(type === 'directory' ? '5' : '0', 156)
  header.write('ustar\0', 257)
  header.write('00', 263)
  let sum = 0
  for (const byte of header) sum += byte
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return header
}

/** Zero bytes that pad an entry of `size` to the next 512-byte block. */
export function tarPadding(size: number): Buffer {
  return Buffer.alloc((512 - (size % 512)) % 512)
}

/** Two zero blocks end a tar archive. */
export const TAR_END = Buffer.alloc(1024)
