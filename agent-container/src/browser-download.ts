import * as fs from 'fs'
import * as path from 'path'
import { chromium } from 'playwright-core'
import { z } from 'zod'
import { getActivePage } from './browser-upload'

const BrowserDownloadRequestSchema = z.object({
  sessionId: z.string().min(1),
  url: z.string().min(1),
  filename: z.string().min(1).optional(),
})

export type BrowserDownloadRequest = z.infer<typeof BrowserDownloadRequestSchema>

/** Result of an in-page blob fetch, validated at the CDP boundary */
const BlobFetchResultSchema = z.object({
  base64: z.string(),
  contentType: z.string().nullable(),
})

export const DOWNLOADS_DIR = '/workspace/downloads'

/** Hard cap — the whole file is buffered in memory while crossing the CDP wire */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024

interface RunBrowserDownloadOptions {
  validateSession: (sessionId: string) => string | null
  isBrowserActive: () => boolean
  getConnectionUrl: () => string
  getActiveTargetUrl: () => Promise<string | null>
  urlsMatch: (left: string, right: string) => boolean
  /** Override for tests — defaults to /workspace/downloads */
  downloadsDir?: string
}

export interface DownloadedFileInfo {
  name: string
  path: string
  size: number
  contentType: string | null
}

type BrowserDownloadResponse =
  | { success: true; body: { success: true; file: DownloadedFileInfo } }
  | { success: false; status: 400 | 409 | 500; body: { error: string } }

export function parseBrowserDownloadRequest(rawBody: unknown):
  | { success: true; data: BrowserDownloadRequest }
  | { success: false; error: string } {
  const parsed = BrowserDownloadRequestSchema.safeParse(rawBody)
  if (parsed.success) {
    return { success: true, data: parsed.data }
  }
  return {
    success: false,
    error: parsed.error.issues.map(issue => issue.message).join(', '),
  }
}

/** Content types we can map to an extension when the filename has none */
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'audio/mpeg': '.mp3',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/svg+xml': '.svg',
  'image/webp': '.webp',
  'text/csv': '.csv',
  'text/html': '.html',
  'text/plain': '.txt',
  'video/mp4': '.mp4',
}

export function extensionForContentType(contentType: string | null): string | null {
  if (!contentType) return null
  return EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()] || null
}

/**
 * Reduce any candidate filename to a safe basename: strips directories (so a
 * traversal like `../../etc/passwd` becomes `passwd`), removes characters that
 * are unsafe on common filesystems, and caps the length while preserving the
 * extension. Falls back to "download" when nothing usable remains.
 */
export function sanitizeFilename(name: string): string {
  // Normalize both separators before basename so `..\\..\\x` can't slip through
  const base = path.basename(name.replace(/\\/g, '/'))
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '')
  if (!cleaned) return 'download'
  if (cleaned.length <= 150) return cleaned
  const ext = path.extname(cleaned)
  return cleaned.slice(0, 150 - ext.length) + ext
}

/** Extract a filename from a Content-Disposition header (RFC 5987 or plain) */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null
  // RFC 5987: filename*=UTF-8''percent%20encoded.pdf
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header)
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/.exec(header)
  const value = plain ? (plain[1] ?? plain[2])?.trim() : null
  return value || null
}

/** Derive a filename from a URL's pathname (null for empty/root paths) */
export function filenameFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname
    const base = path.posix.basename(pathname)
    if (!base) return null
    try {
      return decodeURIComponent(base)
    } catch {
      return base
    }
  } catch {
    return null
  }
}

/**
 * Pick the final filename: explicit request > Content-Disposition > URL path,
 * then append an extension inferred from the content type when there is none.
 */
export function resolveDownloadFilename(input: {
  explicit?: string
  url: string
  contentDisposition: string | null
  contentType: string | null
}): string {
  const candidate = input.explicit
    || filenameFromContentDisposition(input.contentDisposition)
    || filenameFromUrl(input.url)
    || 'download'
  const sanitized = sanitizeFilename(candidate)
  if (!path.extname(sanitized)) {
    const ext = extensionForContentType(input.contentType)
    if (ext) return sanitized + ext
  }
  return sanitized
}

/** Parse a data: URL into bytes without touching the browser */
export function parseDataUrl(url: string): { buffer: Buffer; contentType: string | null } | null {
  const match = /^data:([^,]*),(.*)$/s.exec(url)
  if (!match) return null
  const meta = match[1]
  const isBase64 = /;base64$/i.test(meta)
  const contentType = meta.replace(/;base64$/i, '') || null
  try {
    const buffer = isBase64
      ? Buffer.from(match[2], 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf8')
    return { buffer, contentType }
  } catch {
    return null
  }
}

/**
 * Write the buffer into the downloads dir without clobbering existing files:
 * `wx` creation with a `-1`, `-2`, ... suffix on collision.
 */
export async function writeDownloadFile(dir: string, filename: string, buffer: Buffer): Promise<string> {
  await fs.promises.mkdir(dir, { recursive: true })
  const ext = path.extname(filename)
  const stem = filename.slice(0, filename.length - ext.length)
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = path.join(dir, attempt === 0 ? filename : `${stem}-${attempt}${ext}`)
    try {
      await fs.promises.writeFile(candidate, buffer, { flag: 'wx' })
      return candidate
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
    }
  }
  throw new Error(`Could not find a free filename for ${filename} in ${dir}`)
}

interface FetchedResource {
  buffer: Buffer
  contentType: string | null
  contentDisposition: string | null
}

function primaryContentType(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null
  return headerValue.split(';')[0].trim().toLowerCase() || null
}

/**
 * Fetch a URL's bytes THROUGH the browser so cookies/login state apply and the
 * bytes travel over the CDP wire — the browser may be running on the host or a
 * remote provider (Browserbase) whose filesystem the container cannot see.
 *
 * - http(s): open a throwaway tab in the browser's own context and read the
 *   navigation response body (immune to CORS, uses the browser's network
 *   stack/proxy/fingerprint). URLs that force an attachment download abort the
 *   navigation — those fall back to the context's request API, which shares
 *   the browser's cookies but issues the request from the container.
 * - blob: evaluated in the ACTIVE page — blob URLs only exist in the document
 *   that created them.
 * - data: decoded directly, no browser round-trip.
 */
export async function fetchResourceViaBrowser(
  url: string,
  options: Pick<RunBrowserDownloadOptions, 'getConnectionUrl' | 'getActiveTargetUrl' | 'urlsMatch'>
): Promise<FetchedResource> {
  const scheme = url.split(':')[0]?.toLowerCase()

  if (scheme === 'data') {
    const parsed = parseDataUrl(url)
    if (!parsed) throw new Error('Malformed data: URL')
    return { buffer: parsed.buffer, contentType: parsed.contentType, contentDisposition: null }
  }

  const browser = await chromium.connectOverCDP(options.getConnectionUrl())
  try {
    if (scheme === 'blob') {
      const page = getActivePage(browser, await options.getActiveTargetUrl(), options.urlsMatch)
      const raw = await page.evaluate(async (blobUrl: string) => {
        const response = await fetch(blobUrl)
        const blob = await response.blob()
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        const chunk = 0x8000
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
        }
        return { base64: btoa(binary), contentType: blob.type || null }
      }, url)
      const result = BlobFetchResultSchema.parse(raw)
      return {
        buffer: Buffer.from(result.base64, 'base64'),
        contentType: primaryContentType(result.contentType),
        contentDisposition: null,
      }
    }

    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(`Unsupported URL scheme: ${scheme || '(none)'} — use http(s), blob: or data: URLs`)
    }

    const context = browser.contexts()[0]
    if (!context) throw new Error('No browser context available')

    const page = await context.newPage()
    try {
      const response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 })
      if (!response) throw new Error('Navigation returned no response')
      if (response.status() >= 400) {
        throw new Error(`HTTP ${response.status()} when fetching ${url}`)
      }
      const headers = response.headers()
      return {
        buffer: await response.body(),
        contentType: primaryContentType(headers['content-type']),
        contentDisposition: headers['content-disposition'] ?? null,
      }
    } catch (error: unknown) {
      // A Content-Disposition: attachment response aborts the navigation with
      // "Download is starting" / ERR_ABORTED. Re-fetch via the context's
      // request API — same cookie jar, plain HTTP semantics, no download.
      const message = error instanceof Error ? error.message : String(error)
      if (!/Download is starting|ERR_ABORTED/i.test(message)) throw error

      const apiResponse = await context.request.get(url, { timeout: 30000 })
      if (!apiResponse.ok()) {
        throw new Error(`HTTP ${apiResponse.status()} when fetching ${url}`)
      }
      const apiHeaders = apiResponse.headers()
      return {
        buffer: await apiResponse.body(),
        contentType: primaryContentType(apiHeaders['content-type']),
        contentDisposition: apiHeaders['content-disposition'] ?? null,
      }
    } finally {
      await page.close().catch(() => { /* page may already be gone */ })
    }
  } finally {
    await browser.close({ reason: 'browser_download complete' }).catch((error) => {
      console.warn('[Browser] Failed to close Playwright CDP connection:', error)
    })
  }
}

export async function runBrowserDownload(
  rawBody: unknown,
  options: RunBrowserDownloadOptions
): Promise<BrowserDownloadResponse> {
  const parsed = parseBrowserDownloadRequest(rawBody)
  if (!parsed.success) {
    return { success: false, status: 400, body: { error: parsed.error } }
  }

  const body = parsed.data
  const validationError = options.validateSession(body.sessionId)
  if (validationError) {
    return { success: false, status: 409, body: { error: validationError } }
  }

  if (!options.isBrowserActive()) {
    return { success: false, status: 400, body: { error: 'Browser is not active — open it with browser_open first' } }
  }

  const scheme = body.url.split(':')[0]?.toLowerCase()
  if (!['http', 'https', 'blob', 'data'].includes(scheme || '')) {
    return {
      success: false,
      status: 400,
      body: { error: `Unsupported URL scheme: ${scheme || '(none)'} — use http(s), blob: or data: URLs` },
    }
  }

  let resource: FetchedResource
  try {
    resource = await fetchResourceViaBrowser(body.url, options)
  } catch (error: unknown) {
    return {
      success: false,
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }

  if (resource.buffer.length === 0) {
    return { success: false, status: 500, body: { error: 'Downloaded 0 bytes — the URL may require different credentials or headers' } }
  }
  if (resource.buffer.length > MAX_DOWNLOAD_BYTES) {
    return {
      success: false,
      status: 400,
      body: { error: `File is ${resource.buffer.length} bytes — exceeds the ${MAX_DOWNLOAD_BYTES} byte browser_download limit` },
    }
  }

  const filename = resolveDownloadFilename({
    explicit: body.filename,
    url: body.url,
    contentDisposition: resource.contentDisposition,
    contentType: resource.contentType,
  })

  let savedPath: string
  try {
    savedPath = await writeDownloadFile(options.downloadsDir || DOWNLOADS_DIR, filename, resource.buffer)
  } catch (error: unknown) {
    return {
      success: false,
      status: 500,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }

  return {
    success: true,
    body: {
      success: true,
      file: {
        name: path.basename(savedPath),
        path: savedPath,
        size: resource.buffer.length,
        contentType: resource.contentType,
      },
    },
  }
}
