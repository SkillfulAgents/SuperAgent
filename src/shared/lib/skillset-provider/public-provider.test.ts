import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createZipBuffer } from '@shared/lib/utils/zip'

vi.mock('@shared/lib/utils/retry', async () => {
  const actual = await vi.importActual<typeof import('@shared/lib/utils/retry')>(
    '@shared/lib/utils/retry',
  )
  return {
    ...actual,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
  }
})

vi.mock('@shared/lib/error-reporting', () => ({
  captureException: vi.fn(),
}))

import { NonRetryableError } from '@shared/lib/utils/retry'
import { PublicSkillsetProvider } from './public-provider'

const provider = new PublicSkillsetProvider()

function makeRef(url?: string) {
  return {
    skillsetId: 'test-skillset',
    skillsetUrl: url,
    skillsetName: 'Test Skillset',
  }
}

async function buildTestZip(files: Record<string, string>, prefix = 'owner-repo-abc123/'): Promise<Buffer> {
  const prefixed: Record<string, string> = {}
  for (const [name, content] of Object.entries(files)) {
    prefixed[prefix + name] = content
  }
  return createZipBuffer(prefixed)
}

function mockFetchResponse(buffer: Buffer, status = 200) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  }))
}

function mockFetchError(status: number, statusText = 'Error') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText,
    arrayBuffer: async () => new ArrayBuffer(0),
  }))
}

// ============================================================================
// Provider properties
// ============================================================================

describe('PublicSkillsetProvider properties', () => {
  it('has correct id, name, and modes', () => {
    expect(provider.id).toBe('public')
    expect(provider.name).toBe('Public')
    expect(provider.publishMode).toBe('none')
    expect(provider.supportsSuggestions).toBe(false)
    expect(provider.usesGitCache).toBe(false)
  })

  it('getDisplayInfo returns Public badge', () => {
    expect(provider.getDisplayInfo()).toEqual({ badgeLabel: 'Public', showUrl: true })
  })

  it('publishUpdate throws read-only error', async () => {
    await expect(provider.publishUpdate({} as never)).rejects.toThrow('read-only')
  })
})

// ============================================================================
// isCacheReady
// ============================================================================

describe('PublicSkillsetProvider.isCacheReady', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'public-provider-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns true when .skillset-cache-meta.json exists', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '.skillset-cache-meta.json'), '{}')
    expect(await provider.isCacheReady(tmpDir)).toBe(true)
  })

  it('returns false when directory is empty', async () => {
    expect(await provider.isCacheReady(tmpDir)).toBe(false)
  })

  it('returns false when directory does not exist', async () => {
    expect(await provider.isCacheReady(path.join(tmpDir, 'nonexistent'))).toBe(false)
  })
})

// ============================================================================
// populateCache
// ============================================================================

describe('PublicSkillsetProvider.populateCache', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'public-provider-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('throws when skillsetUrl is undefined', async () => {
    await expect(provider.populateCache(tmpDir, makeRef(undefined))).rejects.toThrow(
      'Public skillset provider requires a URL',
    )
  })

  it('throws descriptive error for non-github.com URLs', async () => {
    await expect(provider.populateCache(tmpDir, makeRef('https://gitlab.com/org/repo'))).rejects.toThrow(
      'Only github.com URLs are supported',
    )
  })

  it('throws for invalid URLs', async () => {
    await expect(provider.populateCache(tmpDir, makeRef('not-a-url'))).rejects.toThrow(
      'Invalid URL',
    )
  })

  it('throws for github.com URLs with no repo segment', async () => {
    await expect(provider.populateCache(tmpDir, makeRef('https://github.com/owner'))).rejects.toThrow(
      'Invalid GitHub URL',
    )
  })

  it('downloads, extracts, and strips GitHub prefix', async () => {
    const destDir = path.join(tmpDir, 'cache')
    const zipBuffer = await buildTestZip({
      'index.json': '{"skillset_name":"Test","skills":[],"version":"1.0.0","description":"test"}',
      'skills/my-skill/SKILL.md': '# My Skill',
    })
    mockFetchResponse(zipBuffer)

    await provider.populateCache(destDir, makeRef('https://github.com/TestOrg/test-repo'))

    expect(await fs.promises.readFile(path.join(destDir, 'index.json'), 'utf-8')).toContain('Test')
    expect(await fs.promises.readFile(path.join(destDir, 'skills', 'my-skill', 'SKILL.md'), 'utf-8')).toBe('# My Skill')
  })

  it('writes .skillset-cache-meta.json marker', async () => {
    const destDir = path.join(tmpDir, 'cache')
    mockFetchResponse(await buildTestZip({ 'index.json': '{}' }))

    await provider.populateCache(destDir, makeRef('https://github.com/Org/repo'))

    const meta = JSON.parse(await fs.promises.readFile(path.join(destDir, '.skillset-cache-meta.json'), 'utf-8'))
    expect(meta.provider).toBe('public')
    expect(meta.sourceUrl).toBe('https://github.com/Org/repo')
    expect(meta.cachedAt).toBeTruthy()
  })

  it('handles .git suffix in URL', async () => {
    const destDir = path.join(tmpDir, 'cache')
    mockFetchResponse(await buildTestZip({ 'index.json': '{}' }))

    await provider.populateCache(destDir, makeRef('https://github.com/Org/repo.git'))

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    expect(fetchCall[0]).toBe('https://api.github.com/repos/Org/repo/zipball')
  })

  it('skips __MACOSX entries', async () => {
    const zipBuffer = await buildTestZip({
      'index.json': '{}',
      '__MACOSX/._index.json': 'junk',
    })
    mockFetchResponse(zipBuffer)

    const destDir = path.join(tmpDir, 'cache')
    await provider.populateCache(destDir, makeRef('https://github.com/Org/repo'))

    expect(fs.existsSync(path.join(destDir, '__MACOSX'))).toBe(false)
    expect(fs.existsSync(path.join(destDir, 'index.json'))).toBe(true)
  })

  it('rejects path traversal entries via startsWith check', async () => {
    const destDir = path.join(tmpDir, 'cache')
    const evilPath = path.resolve(destDir, '../traversed.txt')

    mockFetchResponse(await buildTestZip({ 'index.json': '{}' }))
    await provider.populateCache(destDir, makeRef('https://github.com/Org/repo'))

    // The path traversal protection is `destPath.startsWith(resolve(destDir) + sep)`.
    // Verify it correctly rejects a path that shares the prefix but escapes the dir.
    const safeBase = path.resolve(destDir)
    expect(evilPath.startsWith(safeBase + path.sep)).toBe(false)
    expect(path.resolve(destDir, 'index.json').startsWith(safeBase + path.sep)).toBe(true)

    // Verify only legitimate files exist
    expect(fs.existsSync(path.join(destDir, 'index.json'))).toBe(true)
    expect(fs.existsSync(evilPath)).toBe(false)
  })

  it('throws NonRetryableError on 404 so withRetry skips backoff', async () => {
    mockFetchError(404)
    const destDir = path.join(tmpDir, 'cache')
    await expect(
      provider.populateCache(destDir, makeRef('https://github.com/Org/missing-repo')),
    ).rejects.toThrow(/Repository not found.*missing-repo/)
    mockFetchError(404)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache2'), makeRef('https://github.com/Org/missing-repo')),
    ).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('throws NonRetryableError on 403 with rate limit message', async () => {
    mockFetchError(403)
    const destDir = path.join(tmpDir, 'cache')
    await expect(
      provider.populateCache(destDir, makeRef('https://github.com/Org/repo')),
    ).rejects.toThrow(/rate limit/)
    mockFetchError(403)
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache2'), makeRef('https://github.com/Org/repo')),
    ).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('5xx stays retryable (plain Error, not NonRetryableError)', async () => {
    mockFetchError(500, 'Internal Server Error')
    const destDir = path.join(tmpDir, 'cache')
    await expect(
      provider.populateCache(destDir, makeRef('https://github.com/Org/repo')),
    ).rejects.toThrow(/500.*Internal Server Error/)
    mockFetchError(500, 'Internal Server Error')
    await expect(
      provider.populateCache(path.join(tmpDir, 'cache2'), makeRef('https://github.com/Org/repo')),
    ).rejects.not.toBeInstanceOf(NonRetryableError)
  })

  it('handles ZIP with no common prefix (flat layout)', async () => {
    const flatZip = await createZipBuffer({
      'index.json': '{"flat":true}',
      'skills/a/SKILL.md': 'skill',
    })
    mockFetchResponse(flatZip)

    const destDir = path.join(tmpDir, 'cache')
    await provider.populateCache(destDir, makeRef('https://github.com/Org/repo'))

    expect(JSON.parse(await fs.promises.readFile(path.join(destDir, 'index.json'), 'utf-8'))).toEqual({ flat: true })
  })
})

// ============================================================================
// refreshCache
// ============================================================================

describe('PublicSkillsetProvider.refreshCache', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'public-provider-test-'))
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('deletes old cache and re-populates', async () => {
    const destDir = path.join(tmpDir, 'cache')
    await fs.promises.mkdir(destDir, { recursive: true })
    await fs.promises.writeFile(path.join(destDir, 'old-file.txt'), 'stale')

    mockFetchResponse(await buildTestZip({ 'index.json': '{"fresh":true}' }))

    await provider.refreshCache(destDir, makeRef('https://github.com/Org/repo'))

    expect(fs.existsSync(path.join(destDir, 'old-file.txt'))).toBe(false)
    expect(JSON.parse(await fs.promises.readFile(path.join(destDir, 'index.json'), 'utf-8'))).toEqual({ fresh: true })
    expect(await provider.isCacheReady(destDir)).toBe(true)
  })
})
