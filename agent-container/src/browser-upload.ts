import * as fs from 'fs'
import * as path from 'path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { z } from 'zod'

const BrowserUploadRequestSchema = z.object({
  sessionId: z.string().min(1),
  selector: z.string().min(1).default('input[type="file"]'),
  filePath: z.string().min(1),
})

export type BrowserUploadRequest = z.infer<typeof BrowserUploadRequestSchema>

export interface BrowserUploadFilePayload {
  name: string
  mimeType: string
  buffer: Buffer
  size: number
  resolvedPath: string
}

export interface UploadVerification {
  count: number
  name: string | null
  size: number | null
}

interface UploadToFileInputOptions {
  connectionUrl: string
  activeTargetUrl: string | null
  selector: string
  file: BrowserUploadFilePayload
  urlsMatch: (left: string, right: string) => boolean
}

interface RunBrowserUploadOptions {
  validateSession: (sessionId: string) => string | null
  isBrowserActive: () => boolean
  getConnectionUrl: () => string
  getActiveTargetUrl: () => Promise<string | null>
  urlsMatch: (left: string, right: string) => boolean
}

type BrowserUploadResponse =
  | {
    success: true
    body: {
      success: true
      selector: string
      file: { name: string; size: number; mimeType: string; path: string }
      verification: UploadVerification | null
    }
  }
  | {
    success: false
    status: 400 | 409 | 500
    body: {
      error: string
      expected?: { name: string; size: number }
      verification?: UploadVerification | null
    }
  }

const MIME_TYPES: Record<string, string> = {
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.zip': 'application/zip',
}

export function parseBrowserUploadRequest(rawBody: unknown):
  | { success: true; data: BrowserUploadRequest }
  | { success: false; error: string } {
  const parsed = BrowserUploadRequestSchema.safeParse(rawBody)
  if (parsed.success) {
    return { success: true, data: parsed.data }
  }

  return {
    success: false,
    error: parsed.error.issues.map(issue => issue.message).join(', '),
  }
}

const WORKSPACE_ROOT = '/workspace'

/**
 * Resolve a user-supplied upload path and confine it to the workspace root.
 *
 * `path.resolve` handles both relative inputs (joined under /workspace) and
 * absolute inputs (left as-is). Containment is then checked via `path.relative`
 * (not a bare `startsWith` prefix, which a sibling dir like `/workspace-evil`
 * would pass). Any path that escapes /workspace — an absolute path elsewhere
 * (`/etc/passwd`) or a `../` traversal — is rejected so the browser-upload flow
 * cannot read arbitrary container files. Pure path math: no filesystem access,
 * so it stays unit-testable without a real /workspace.
 */
export function resolveUploadPath(filePath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, filePath)
  const relative = path.relative(WORKSPACE_ROOT, resolved)
  const withinWorkspace =
    relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (!withinWorkspace) {
    throw new Error(`Upload path is outside the workspace: ${filePath}`)
  }
  return resolved
}

export function guessMimeType(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
}

export async function createUploadFilePayload(filePath: string): Promise<BrowserUploadFilePayload> {
  const resolvedPath = resolveUploadPath(filePath)
  const stat = await fs.promises.stat(resolvedPath)
  if (!stat.isFile()) {
    throw new Error(`Upload path is not a file: ${resolvedPath}`)
  }

  return {
    name: path.basename(resolvedPath),
    mimeType: guessMimeType(resolvedPath),
    buffer: await fs.promises.readFile(resolvedPath),
    size: stat.size,
    resolvedPath,
  }
}

export function validateUploadVerification(
  expected: { name: string; size: number },
  verification: UploadVerification | null
): string | null {
  if (!verification) {
    return 'File input did not emit a change event after upload'
  }
  if (verification.count < 1) {
    return 'File input has no files after upload'
  }
  if (verification.name !== expected.name) {
    return `Uploaded file name mismatch: expected ${expected.name}, got ${verification.name || 'none'}`
  }
  if (verification.size !== expected.size) {
    return `Uploaded file size mismatch: expected ${expected.size} bytes, got ${verification.size ?? 'unknown'}`
  }
  return null
}

export async function runBrowserUpload(
  rawBody: unknown,
  options: RunBrowserUploadOptions
): Promise<BrowserUploadResponse> {
  const parsed = parseBrowserUploadRequest(rawBody)
  if (!parsed.success) {
    return { success: false, status: 400, body: { error: parsed.error } }
  }

  const body = parsed.data
  const validationError = options.validateSession(body.sessionId)
  if (validationError) {
    return { success: false, status: 409, body: { error: validationError } }
  }

  if (!options.isBrowserActive()) {
    return { success: false, status: 400, body: { error: 'Browser is not active' } }
  }

  let file: BrowserUploadFilePayload
  try {
    file = await createUploadFilePayload(body.filePath)
  } catch (error) {
    return {
      success: false,
      status: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    }
  }

  const verification = (await uploadToFileInput({
    connectionUrl: options.getConnectionUrl(),
    activeTargetUrl: await options.getActiveTargetUrl(),
    selector: body.selector,
    file,
    urlsMatch: options.urlsMatch,
  })).verification

  const verificationError = validateUploadVerification(
    { name: file.name, size: file.size },
    verification
  )

  if (verificationError) {
    return {
      success: false,
      status: 500,
      body: {
        error: verificationError,
        expected: { name: file.name, size: file.size },
        verification,
      },
    }
  }

  return {
    success: true,
    body: {
      success: true,
      selector: body.selector,
      file: {
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        path: file.resolvedPath,
      },
      verification,
    },
  }
}

export async function uploadToFileInput({
  connectionUrl,
  activeTargetUrl,
  selector,
  file,
  urlsMatch,
}: UploadToFileInputOptions): Promise<{ verification: UploadVerification | null }> {
  const browser = await chromium.connectOverCDP(connectionUrl)
  try {
    const page = getActivePage(browser, activeTargetUrl, urlsMatch)
    const locator = page.locator(selector).first()
    if (await locator.count() === 0) {
      throw new Error(`No file input matched selector: ${selector}`)
    }

    const verificationKey = `__superagentUpload_${Date.now()}_${Math.random().toString(36).slice(2)}`
    await locator.evaluate((element: any, key: string) => {
      ;(globalThis as typeof globalThis & Record<string, UploadVerification | null>)[key] = null
      element.addEventListener('change', () => {
        const uploadedFile = element.files?.[0] ?? null
        ;(globalThis as typeof globalThis & Record<string, UploadVerification | null>)[key] = {
          count: element.files?.length ?? 0,
          name: uploadedFile?.name ?? null,
          size: uploadedFile?.size ?? null,
        }
      }, { once: true })
    }, verificationKey)

    await locator.setInputFiles({
      name: file.name,
      mimeType: file.mimeType,
      buffer: file.buffer,
    })

    return {
      verification: await readUploadVerification(page, selector, verificationKey),
    }
  } finally {
    await browser.close({ reason: 'browser_upload complete' }).catch((error) => {
      console.warn('[Browser] Failed to close Playwright CDP connection:', error)
    })
  }
}

/** Find the Playwright page matching the daemon's active tab (shared with browser-download) */
export function getActivePage(
  browser: Browser,
  activeTargetUrl: string | null,
  urlsMatch: (left: string, right: string) => boolean
): Page {
  const pages = browser.contexts().flatMap(context => context.pages())
  if (pages.length === 0) {
    throw new Error('No browser pages available')
  }

  const activePage = activeTargetUrl
    ? pages.find(page => urlsMatch(page.url(), activeTargetUrl))
    : null

  return activePage || pages[0]
}

async function readUploadVerification(
  page: Page,
  selector: string,
  verificationKey: string
): Promise<UploadVerification | null> {
  try {
    await page.waitForFunction(
      key => (globalThis as typeof globalThis & Record<string, UploadVerification | null>)[key] !== null,
      verificationKey,
      { timeout: 3000 }
    )
    return await page.evaluate(
      key => (globalThis as typeof globalThis & Record<string, UploadVerification | null>)[key],
      verificationKey
    )
  } catch {
    try {
      return await page.locator(selector).first().evaluate((element: any) => {
        const uploadedFile = element.files?.[0] ?? null
        return {
          count: element.files?.length ?? 0,
          name: uploadedFile?.name ?? null,
          size: uploadedFile?.size ?? null,
        }
      })
    } catch (error) {
      console.warn('[Browser] Failed to read upload verification fallback:', error)
      return null
    }
  }
}
