import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as tar from 'tar'

vi.mock('@shared/lib/utils/retry', async () => {
  const actual = await vi.importActual<typeof import('@shared/lib/utils/retry')>(
    '@shared/lib/utils/retry',
  )
  return {
    ...actual,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
  }
})

const mockGetPlatformProxyBaseUrl = vi.fn()
const mockGetPlatformAccessToken = vi.fn()
const mockGetPlatformAuthStatus = vi.fn()

vi.mock('@shared/lib/platform-auth/config', () => ({
  getPlatformProxyBaseUrl: () => mockGetPlatformProxyBaseUrl(),
}))

vi.mock('@shared/lib/services/platform-auth-service', () => ({
  getPlatformAccessToken: () => mockGetPlatformAccessToken(),
  getPlatformAuthStatus: () => mockGetPlatformAuthStatus(),
}))

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { NonRetryableError } from '@shared/lib/utils/retry'
import {
  PlatformSkillsetProvider,
  setPlatformGitAvailabilityForTesting,
} from './platform-provider'

// Force a known git-availability state so module-level `provider` is
// deterministic across machines (CI may or may not have git installed).
// Individual describe blocks override this when they need the opposite.
setPlatformGitAvailabilityForTesting(false)
const provider = new PlatformSkillsetProvider()

function makeRef(overrides: Partial<{ skillsetId: string; skillsetName: string; repoId: string; orgId: string }> = {}) {
  return {
    skillsetId: overrides.skillsetId ?? 'platform--repo-x--acme-skillset',
    skillsetUrl: 'http://platform.example/v1/skills/repo',
    skillsetName: overrides.skillsetName ?? 'acme-skillset',
    providerData: {
      repoId: overrides.repoId ?? 'repo-x',
      orgId: overrides.orgId ?? 'org_A',
    },
  }
}

describe('PlatformSkillsetProvider.resolveCloneUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://platform.example')
    mockGetPlatformAccessToken.mockReturnValue('plat_test_token_xxxxx')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function mockGitUrlResponse(body: unknown, ok = true) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      statusText: ok ? 'OK' : 'err',
      json: async () => body,
      text: async () => JSON.stringify(body),
    }))
  }

  it('returns the URL when it is on the same origin as the platform proxy', async () => {
    mockGitUrlResponse({ url: 'https://platform.example/git/acme.git', defaultBranch: 'main' })
    const out = await provider.resolveCloneUrl('ignored', makeRef())
    expect(out).toBe('https://platform.example/git/acme.git')
  })

  it('allows clone URLs on a different host than the proxy (separate storage)', async () => {
    mockGitUrlResponse({ url: 'https://storage.example/git/acme.git', defaultBranch: 'main' })
    const out = await provider.resolveCloneUrl('ignored', makeRef())
    expect(out).toBe('https://storage.example/git/acme.git')
  })

  it('rejects URLs pointing at private IPs (SSRF)', async () => {
    // Same origin check would pass only if proxy is also private; set both so
    // the only rejection is from private-host detection.
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://127.0.0.1')
    mockGitUrlResponse({ url: 'http://127.0.0.1/git/acme.git' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Unsafe clone URL host/)
  })

  it('rejects non-http schemes', async () => {
    mockGitUrlResponse({ url: 'ssh://git@platform.example/acme.git' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Unsafe URL protocol/)
  })

  it('throws when the platform returns no URL', async () => {
    mockGitUrlResponse({ url: '' })
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/did not return a clone URL/)
  })

  it('throws when unauthenticated', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    await expect(provider.resolveCloneUrl('ignored', makeRef())).rejects.toThrow(/Platform not connected/)
  })
})

describe('PlatformSkillsetProvider archive cache (no-git path)', () => {
  let tmpDir: string

  beforeEach(async () => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://platform.example')
    mockGetPlatformAccessToken.mockReturnValue('plat_test_token_xxxxx')
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'platform-provider-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  /**
   * Build an in-memory tar.gz buffer from flat path → content pairs.
   * Mirrors the format Pierre's getArchiveStream produces.
   */
  async function buildTarGz(files: Record<string, string>): Promise<Buffer> {
    const srcDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tar-src-'))
    try {
      for (const [relPath, content] of Object.entries(files)) {
        const full = path.join(srcDir, relPath)
        await fs.promises.mkdir(path.dirname(full), { recursive: true })
        await fs.promises.writeFile(full, content, 'utf-8')
      }
      const chunks: Buffer[] = []
      const stream = tar.c({ gzip: true, cwd: srcDir }, Object.keys(files))
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      }
      return Buffer.concat(chunks)
    } finally {
      await fs.promises.rm(srcDir, { recursive: true, force: true })
    }
  }

  function mockArchiveFetch(buffer: Buffer, status = 200) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      arrayBuffer: async () =>
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    }))
  }

  it('usesGitCache is false when git is unavailable (fallback path)', () => {
    setPlatformGitAvailabilityForTesting(false)
    const p = new PlatformSkillsetProvider()
    expect(p.usesGitCache).toBe(false)
  })

  it('usesGitCache is true when git is available (default git-clone path)', () => {
    setPlatformGitAvailabilityForTesting(true)
    const p = new PlatformSkillsetProvider()
    expect(p.usesGitCache).toBe(true)
    setPlatformGitAvailabilityForTesting(false)
  })

  it('isCacheReady returns false on empty dir and true after populateCache', async () => {
    const destDir = path.join(tmpDir, 'cache')
    expect(await provider.isCacheReady(destDir)).toBe(false)

    mockArchiveFetch(await buildTarGz({
      'index.json': '{"skillset_name":"acme-skillset","skills":[]}',
      'skills/foo/SKILL.md': '# Foo',
    }))
    await provider.populateCache(destDir, makeRef())

    expect(await provider.isCacheReady(destDir)).toBe(true)
    expect(await fs.promises.readFile(path.join(destDir, 'skills/foo/SKILL.md'), 'utf-8'))
      .toBe('# Foo')
  })

  it('populateCache calls the proxy archive endpoint with bearer auth', async () => {
    const tarGz = await buildTarGz({ 'index.json': '{}' })
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        tarGz.buffer.slice(tarGz.byteOffset, tarGz.byteOffset + tarGz.byteLength),
    })
    vi.stubGlobal('fetch', fetchSpy)

    await provider.populateCache(path.join(tmpDir, 'cache'), makeRef())

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://platform.example/v1/skills/archive?skillset=acme-skillset')
    expect(init.headers.Authorization).toBe('Bearer plat_test_token_xxxxx')
  })

  it('populateCache throws "Platform not connected" when no token', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache'), makeRef()),
    ).rejects.toThrow(/Platform not connected/)
  })

  it('populateCache maps 404 to a NonRetryableError so withRetry skips backoff', async () => {
    mockArchiveFetch(Buffer.alloc(0), 404)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache'), makeRef()),
    ).rejects.toThrow(/Platform skillset not found: acme-skillset/)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache2'), makeRef()),
    ).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('populateCache maps 401/403 to a NonRetryableError reconnect message', async () => {
    mockArchiveFetch(Buffer.alloc(0), 401)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache'), makeRef()),
    ).rejects.toThrow(/Not authorized.*Reconnect to platform/)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache2'), makeRef()),
    ).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('populateCache maps 5xx to a transient server-error message', async () => {
    mockArchiveFetch(Buffer.alloc(0), 502)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache'), makeRef()),
    ).rejects.toThrow(/Platform server error.*502.*try again/)
  })

  it('populateCache rejects unsafe archive URLs (proxy on private IP)', async () => {
    mockGetPlatformProxyBaseUrl.mockReturnValue('http://127.0.0.1')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache'), makeRef()),
    ).rejects.toThrow(/Unsafe clone URL host/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('populateCache drops __MACOSX entries silently', async () => {
    const srcDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tar-macosx-'))
    await fs.promises.mkdir(path.join(srcDir, '__MACOSX'), { recursive: true })
    await fs.promises.writeFile(path.join(srcDir, '__MACOSX/._junk'), 'rsrc')
    await fs.promises.writeFile(path.join(srcDir, 'index.json'), '{}')
    const chunks: Buffer[] = []
    const stream = tar.c({ gzip: true, cwd: srcDir }, ['__MACOSX', 'index.json'])
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    await fs.promises.rm(srcDir, { recursive: true, force: true })

    mockArchiveFetch(Buffer.concat(chunks))
    const destDir = path.join(tmpDir, 'cache')

    await expect(provider.populateCache(destDir, makeRef())).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(destDir, '__MACOSX'))).toBe(false)
    expect(fs.existsSync(path.join(destDir, 'index.json'))).toBe(true)
  })

  it('populateCache rejects tar entries with path traversal', async () => {
    // Hand-craft a tar where an entry has a `..` segment. tar.x with our
    // filter + strict should drop it without writing outside cacheDir.
    const srcDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tar-evil-'))
    await fs.promises.writeFile(path.join(srcDir, 'evil.txt'), 'evil')
    const tarGz = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = tar.c(
        {
          gzip: true,
          cwd: srcDir,
          prefix: '../escape',
        },
        ['evil.txt'],
      )
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('end', () => resolve(Buffer.concat(chunks)))
      stream.on('error', reject)
    })
    await fs.promises.rm(srcDir, { recursive: true, force: true })

    mockArchiveFetch(tarGz)
    const destDir = path.join(tmpDir, 'cache')

    // The tar.x filter drops `..` entries silently, so populateCache resolves
    // successfully but the escape path must not have been written.
    await expect(
      provider.populateCache(destDir, makeRef()),
    ).resolves.toBeUndefined()
    expect(fs.existsSync(path.resolve(destDir, '../escape/evil.txt'))).toBe(false)
  })

  it('refreshCache replaces stale cache atomically', async () => {
    const destDir = path.join(tmpDir, 'cache')
    await fs.promises.mkdir(destDir, { recursive: true })
    await fs.promises.writeFile(path.join(destDir, 'stale.txt'), 'old')

    mockArchiveFetch(await buildTarGz({ 'index.json': '{"fresh":true}' }))
    await provider.refreshCache(destDir, makeRef())

    expect(fs.existsSync(path.join(destDir, 'stale.txt'))).toBe(false)
    expect(JSON.parse(await fs.promises.readFile(path.join(destDir, 'index.json'), 'utf-8')))
      .toEqual({ fresh: true })
    expect(await provider.isCacheReady(destDir)).toBe(true)
  })
})

describe('PlatformSkillsetProvider.getQueueItemStatuses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGetPlatformProxyBaseUrl.mockReturnValue('https://platform.example')
    mockGetPlatformAccessToken.mockReturnValue('plat_test_token_xxxxx')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns empty map without calling fetch when ids is empty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const result = await provider.getQueueItemStatuses([])
    expect(result.size).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('uses a single batch request when the server supports it', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        items: {
          a: { status: 'merged' },
          b: { status: 'pending' },
          c: null,
        },
      }),
    })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await provider.getQueueItemStatuses(['a', 'b', 'c'])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const call = fetchSpy.mock.calls[0]
    expect(call[0]).toBe('https://platform.example/v1/skills/queue/batch')
    expect(call[1].method).toBe('POST')
    expect(JSON.parse(call[1].body)).toEqual({ ids: ['a', 'b', 'c'] })
    expect(result.get('a')).toBe('merged')
    expect(result.get('b')).toBe('pending')
    expect(result.get('c')).toBe(null)
  })

  it('falls back to per-id GETs when the batch endpoint is unavailable', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 }) // batch missing
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ item: { status: 'merged' } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ item: { status: 'rejected' } }) })
    vi.stubGlobal('fetch', fetchSpy)

    const result = await provider.getQueueItemStatuses(['a', 'b'])
    expect(fetchSpy).toHaveBeenCalledTimes(3) // batch + 2 per-id
    expect(result.get('a')).toBe('merged')
    expect(result.get('b')).toBe('rejected')
  })

  it('returns nulls when unauthenticated', async () => {
    mockGetPlatformAccessToken.mockReturnValue(null)
    const result = await provider.getQueueItemStatuses(['a', 'b'])
    expect(result.get('a')).toBe(null)
    expect(result.get('b')).toBe(null)
  })
})

describe('PlatformSkillsetProvider.isConfigValid / isInstalledValid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('github configs are always valid', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ connected: false, orgId: null, source: null })
    const valid = provider.isConfigValid({
      id: 'github--foo',
      url: 'https://github.com/example/foo.git',
      name: 'foo',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'github',
    })
    expect(valid).toBe(true)
  })

  it('platform config is valid only when orgId matches current auth', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_A', source: 'settings' })
    const make = (orgId: string) => ({
      id: 'platform--x',
      url: 'u',
      name: 'x',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform' as const,
      providerData: { orgId, repoId: 'r' },
    })
    expect(provider.isConfigValid(make('org_A'))).toBe(true)
    expect(provider.isConfigValid(make('org_B'))).toBe(false)
  })

  it('platform config invalid when disconnected', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ connected: false, orgId: null, source: null })
    expect(provider.isConfigValid({
      id: 'platform--x',
      url: 'u',
      name: 'x',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform',
      providerData: { orgId: 'org_A', repoId: 'r' },
    })).toBe(false)
  })

  it('isInstalledValid checks orgId match the same way', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_A', source: 'settings' })
    expect(provider.isInstalledValid({
      provider: 'platform',
      providerData: { orgId: 'org_A' },
    })).toBe(true)
    expect(provider.isInstalledValid({
      provider: 'platform',
      providerData: { orgId: 'org_B' },
    })).toBe(false)
    expect(provider.isInstalledValid({ provider: 'github' })).toBe(true)
  })

  it('does not use env-decoded orgId for local isolation decisions', () => {
    mockGetPlatformAuthStatus.mockReturnValue({ connected: true, orgId: 'org_A', source: 'env' })

    expect(provider.isConfigValid({
      id: 'platform--x',
      url: 'u',
      name: 'x',
      description: '',
      addedAt: '2026-01-01T00:00:00.000Z',
      provider: 'platform',
      providerData: { orgId: 'org_B', repoId: 'r' },
    })).toBe(true)

    expect(provider.isInstalledValid({
      provider: 'platform',
      providerData: { orgId: 'org_B' },
    })).toBe(true)
  })
})
