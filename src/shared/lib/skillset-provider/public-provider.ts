import path from 'path'
import fs from 'fs'
import pLimit from 'p-limit'
import { ensureDirectory } from '@shared/lib/utils/file-storage'
import { openZipFromBuffer, detectZipPrefix, ZipExtractionSizeError } from '@shared/lib/utils/zip'
import { validateSafeCloneUrl } from '@shared/lib/utils/url-safety'
import { isPathWithinDir } from '@shared/lib/utils/path-safety'
import { withRetry, NonRetryableError } from '@shared/lib/utils/retry'
import { atomicSwapCacheDir } from './atomic-cache-swap'
import {
  BaseSkillsetProvider,
  type SkillsetPublishInput,
  type SkillsetPublishResult,
  type SkillsetProviderRef,
  type SkillsetDisplayInfo,
} from './base-skillset-provider'

const CACHE_META_FILENAME = '.skillset-cache-meta.json'

export class PublicSkillsetProvider extends BaseSkillsetProvider {
  readonly id = 'public' as const
  readonly name = 'Public'
  readonly publishMode = 'none' as const
  readonly supportsSuggestions = false
  readonly usesGitCache = false

  override getDisplayInfo(): SkillsetDisplayInfo {
    return { badgeLabel: 'Public', showUrl: true }
  }

  override async isCacheReady(cacheDir: string): Promise<boolean> {
    try {
      await fs.promises.access(path.join(cacheDir, CACHE_META_FILENAME))
      return true
    } catch {
      return false
    }
  }

  override async populateCache(cacheDir: string, ref: SkillsetProviderRef): Promise<void> {
    if (!ref.skillsetUrl) {
      throw new Error('Public skillset provider requires a URL')
    }
    const zipballUrl = buildZipballUrl(ref.skillsetUrl)
    const zipBuffer = await downloadZip(zipballUrl, ref.skillsetUrl)
    await extractZipToDir(zipBuffer, cacheDir)
    await writeCacheMeta(cacheDir, ref.skillsetUrl)
  }

  override async refreshCache(cacheDir: string, ref: SkillsetProviderRef): Promise<void> {
    const tmpDir = cacheDir + '.tmp-' + Date.now()
    try {
      await this.populateCache(tmpDir, ref)
    } catch (err) {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    // Swap atomically so a failed rename (Windows EPERM/EBUSY) can never leave
    // the user with a destroyed cache instead of a working one.
    await atomicSwapCacheDir(cacheDir, tmpDir)
  }

  override async publishUpdate(_input: SkillsetPublishInput): Promise<SkillsetPublishResult> {
    throw new Error('Public skillsets are read-only. Publishing is not supported.')
  }
}

function buildZipballUrl(repoUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(repoUrl)
  } catch {
    throw new Error(`Invalid URL: ${repoUrl}`)
  }
  if (parsed.hostname !== 'github.com') {
    throw new Error(`Only github.com URLs are supported for public skillsets: ${repoUrl}`)
  }
  const parts = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '').split('/')
  if (parts.length < 2) {
    throw new Error('Invalid GitHub URL: expected https://github.com/{owner}/{repo}')
  }
  const [owner, repo] = parts
  return `https://api.github.com/repos/${owner}/${repo}/zipball`
}

async function downloadZip(zipballUrl: string, originalUrl: string): Promise<Buffer> {
  validateSafeCloneUrl(zipballUrl, {
    allowedHostPrefixes: ['https://api.github.com'],
  })

  return withRetry(async () => {
    const response = await fetch(zipballUrl, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Superagent-App',
      },
      redirect: 'follow',
    })
    if (!response.ok) {
      // 4xx from GitHub are deterministic — don't waste retry delays.
      if (response.status === 404) {
        throw new NonRetryableError(
          `Repository not found: ${originalUrl}\n` +
          'Make sure the repository exists and is public.',
        )
      }
      if (response.status === 403) {
        throw new NonRetryableError(
          'GitHub API rate limit exceeded. Please try again later.',
        )
      }
      if (response.status >= 500) {
        throw new Error(`Failed to download skillset: ${response.status} ${response.statusText}`)
      }
      throw new NonRetryableError(
        `Failed to download skillset: ${response.status} ${response.statusText}`,
      )
    }
    return Buffer.from(await response.arrayBuffer())
  }, 3, 1000)
}

export async function extractZipToDir(
  zipBuffer: Buffer,
  destDir: string,
  maxBytes = 500 * 1024 * 1024,
): Promise<void> {
  const reader = await openZipFromBuffer(zipBuffer)
  try {
    const stripPrefix = detectZipPrefix(reader.entries)

    await ensureDirectory(destDir)

    const jobs: Array<{ fileName: string; destPath: string; uncompressedSize: number }> = []
    for (const entry of reader.entries) {
      if (entry.isDirectory) continue

      const entryName = stripPrefix
        ? entry.fileName.slice(stripPrefix.length)
        : entry.fileName

      if (!entryName) continue
      if (entryName.startsWith('__MACOSX/')) continue

      const destPath = path.resolve(destDir, entryName)
      if (!isPathWithinDir(destDir, destPath)) continue

      jobs.push({ fileName: entry.fileName, destPath, uncompressedSize: entry.uncompressedSize })
    }

    const declared = jobs.reduce((sum, job) => sum + job.uncompressedSize, 0)
    if (declared > maxBytes) {
      throw new ZipExtractionSizeError(maxBytes, declared)
    }

    const limit = pLimit(8)
    await Promise.all(jobs.map((job) => limit(async () => {
      await ensureDirectory(path.dirname(job.destPath))
      await reader.extractEntry(job.fileName, job.destPath, job.uncompressedSize)
    })))
  } finally {
    reader.close()
  }
}

async function writeCacheMeta(destDir: string, originalUrl: string): Promise<void> {
  await fs.promises.writeFile(
    path.join(destDir, CACHE_META_FILENAME),
    JSON.stringify({
      provider: 'public',
      cachedAt: new Date().toISOString(),
      sourceUrl: originalUrl,
    }, null, 2),
    'utf-8',
  )
}


