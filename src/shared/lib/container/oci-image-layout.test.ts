import { describe, it, expect } from 'vitest'
import {
  TAR_END,
  blobPath,
  layoutMetadata,
  parseBearerChallenge,
  parseImageRef,
  selectPlatformManifest,
  tarHeader,
  tarPadding,
} from '../../../../scripts/lib/oci-image'

const digest = (c: string) => `sha256:${c.repeat(64)}`

describe('parseImageRef', () => {
  it('splits registry, repository and tag', () => {
    expect(parseImageRef('ghcr.io/skillfulagents/superagent-agent-container-base:0.5.49')).toEqual({
      registry: 'ghcr.io',
      repository: 'skillfulagents/superagent-agent-container-base',
      tag: '0.5.49',
    })
    expect(parseImageRef('localhost.test:5000/a/b:1.0.0-rc.3').registry).toBe('localhost.test:5000')
  })

  it('refuses a reference without an explicit registry or tag', () => {
    expect(() => parseImageRef('superagent:1.0.0')).toThrow(/registry\/repository:tag/)
    expect(() => parseImageRef('ghcr.io/acme/agent')).toThrow(/registry\/repository:tag/)
  })
})

describe('parseBearerChallenge', () => {
  it('reads realm, service and scope', () => {
    expect(
      parseBearerChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/agent:pull"')
    ).toEqual({ realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:acme/agent:pull' })
  })

  it('returns null for anything but a Bearer challenge with a realm', () => {
    expect(parseBearerChallenge('Basic realm="registry"')).toBeNull()
    expect(parseBearerChallenge('Bearer service="ghcr.io"')).toBeNull()
    expect(parseBearerChallenge('')).toBeNull()
  })
})

describe('selectPlatformManifest', () => {
  const manifest = (c: string, architecture: string, os = 'linux') => ({
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: digest(c),
    size: 100,
    platform: { os, architecture },
  })

  it('picks the linux image for the architecture, past the build attestations', () => {
    const index = {
      manifests: [manifest('1', 'amd64'), manifest('2', 'arm64'), manifest('3', 'unknown', 'unknown'), manifest('4', 'unknown', 'unknown')],
    }

    expect(selectPlatformManifest(index, 'arm64').digest).toBe(digest('2'))
    expect(selectPlatformManifest(index, 'amd64').digest).toBe(digest('1'))
  })

  it('throws, naming what the index has, when the architecture is missing', () => {
    expect(() => selectPlatformManifest({ manifests: [manifest('1', 'amd64')] }, 'arm64')).toThrow(/found 0 \(linux\/amd64\)/)
  })
})

describe('layoutMetadata', () => {
  it('names the image the way docker save does, for containerd and Docker alike', () => {
    const image = 'ghcr.io/acme/agent:1.0.0'
    const manifest = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest('c'), size: 6379 }
    const parsed = {
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest('d'), size: 10 },
      layers: [
        { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digest('e'), size: 20 },
        { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: digest('f'), size: 30 },
      ],
    }

    const files = Object.fromEntries(layoutMetadata(image, manifest, parsed).map((f) => [f.name, JSON.parse(f.body.toString())]))

    expect(files['oci-layout']).toEqual({ imageLayoutVersion: '1.0.0' })
    expect(files['index.json'].manifests).toEqual([
      {
        ...manifest,
        annotations: { 'io.containerd.image.name': image, 'org.opencontainers.image.ref.name': '1.0.0' },
      },
    ])
    expect(files['manifest.json']).toEqual([
      {
        Config: `blobs/sha256/${'d'.repeat(64)}`,
        RepoTags: [image],
        Layers: [`blobs/sha256/${'e'.repeat(64)}`, `blobs/sha256/${'f'.repeat(64)}`],
      },
    ])
  })

  it('refuses a digest it cannot lay out', () => {
    expect(() => blobPath('sha512:abc')).toThrow(/Unsupported digest/)
  })
})

describe('tar entries', () => {
  const field = (header: Buffer, offset: number, length: number) =>
    header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '')

  it('writes a ustar header tar readers accept: name, size, type and a valid checksum', () => {
    const header = tarHeader(`blobs/sha256/${'a'.repeat(64)}`, 254194860)

    expect(header.length).toBe(512)
    expect(field(header, 0, 100)).toBe(`blobs/sha256/${'a'.repeat(64)}`)
    expect(parseInt(field(header, 124, 12), 8)).toBe(254194860)
    expect(field(header, 156, 1)).toBe('0')
    expect(field(header, 257, 6)).toBe('ustar')
    const recorded = parseInt(field(header, 148, 8), 8)
    const blanked = Buffer.from(header)
    blanked.write('        ', 148)
    expect(recorded).toBe(blanked.reduce((sum, byte) => sum + byte, 0))
  })

  it('is the same bytes for the same entry: no owner, no timestamp', () => {
    expect(tarHeader('index.json', 393).equals(tarHeader('index.json', 393))).toBe(true)
    expect(parseInt(field(tarHeader('index.json', 393), 136, 12), 8)).toBe(0)
  })

  it('marks directories and pads to whole blocks', () => {
    expect(field(tarHeader('blobs/', 0, 'directory'), 156, 1)).toBe('5')
    expect(tarPadding(512).length).toBe(0)
    expect(tarPadding(513).length).toBe(511)
    expect(TAR_END.length).toBe(1024)
  })

  it('refuses a name ustar cannot hold without a prefix', () => {
    expect(() => tarHeader('x'.repeat(101), 1)).toThrow(/too long/)
  })
})
