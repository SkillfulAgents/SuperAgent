import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  extensionForContentType,
  filenameFromContentDisposition,
  filenameFromUrl,
  parseBrowserDownloadRequest,
  parseDataUrl,
  resolveDownloadFilename,
  runBrowserDownload,
  sanitizeFilename,
  writeDownloadFile,
} from './browser-download'

describe('browser download request parsing', () => {
  it('parses a minimal request', () => {
    expect(parseBrowserDownloadRequest({
      sessionId: 'session-1',
      url: 'https://example.com/photo.jpg',
    })).toEqual({
      success: true,
      data: { sessionId: 'session-1', url: 'https://example.com/photo.jpg' },
    })
  })

  it('rejects requests missing a url', () => {
    const parsed = parseBrowserDownloadRequest({ sessionId: 'session-1' })
    expect(parsed.success).toBe(false)
  })
})

describe('sanitizeFilename', () => {
  it('strips directory traversal down to the basename', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe')).toBe('cmd.exe')
  })

  it('removes unsafe characters and trims dots/spaces', () => {
    expect(sanitizeFilename('  re<po>rt:v1?.pdf  ')).toBe('reportv1.pdf')
    expect(sanitizeFilename('...hidden...')).toBe('hidden')
  })

  it('falls back to "download" when nothing usable remains', () => {
    expect(sanitizeFilename('...')).toBe('download')
    expect(sanitizeFilename('<>:"|?*')).toBe('download')
  })

  it('caps length while preserving the extension', () => {
    const long = 'a'.repeat(200) + '.jpeg'
    const result = sanitizeFilename(long)
    expect(result.length).toBe(150)
    expect(result.endsWith('.jpeg')).toBe(true)
  })
})

describe('filenameFromContentDisposition', () => {
  it('parses quoted filenames', () => {
    expect(filenameFromContentDisposition('attachment; filename="report.pdf"')).toBe('report.pdf')
  })

  it('parses unquoted filenames', () => {
    expect(filenameFromContentDisposition('attachment; filename=report.pdf')).toBe('report.pdf')
  })

  it('prefers the RFC 5987 extended form', () => {
    expect(filenameFromContentDisposition(
      'attachment; filename="fallback.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf'
    )).toBe('résumé.pdf')
  })

  it('returns null for missing headers', () => {
    expect(filenameFromContentDisposition(null)).toBeNull()
    expect(filenameFromContentDisposition('inline')).toBeNull()
  })
})

describe('filenameFromUrl', () => {
  it('takes the last path segment, ignoring the query string', () => {
    // Shape of a real LinkedIn media URL — the trigger case for this tool
    expect(filenameFromUrl(
      'https://media.licdn.com/dms/image/v2/D5603AQGo26bYjMHGxw/profile-displayphoto-crop_800_800/0/1752140421383?e=1785369600&v=beta&t=OJ4'
    )).toBe('1752140421383')
    expect(filenameFromUrl('https://example.com/files/report%20final.pdf?dl=1')).toBe('report final.pdf')
  })

  it('returns null for root paths and invalid URLs', () => {
    expect(filenameFromUrl('https://example.com/')).toBeNull()
    expect(filenameFromUrl('not a url')).toBeNull()
  })
})

describe('resolveDownloadFilename', () => {
  it('prefers the explicit filename', () => {
    expect(resolveDownloadFilename({
      explicit: 'iddo.jpg',
      url: 'https://media.licdn.com/dms/image/photo?e=1',
      contentDisposition: 'attachment; filename="other.png"',
      contentType: 'image/jpeg',
    })).toBe('iddo.jpg')
  })

  it('appends an extension from the content type when the name has none', () => {
    expect(resolveDownloadFilename({
      url: 'https://media.licdn.com/dms/image/v2/abc/0/1752140421383?e=1',
      contentDisposition: null,
      contentType: 'image/jpeg',
    })).toBe('1752140421383.jpg')
  })

  it('falls back to "download" plus extension for extensionless URLs', () => {
    expect(resolveDownloadFilename({
      url: 'https://example.com/',
      contentDisposition: null,
      contentType: 'application/pdf',
    })).toBe('download.pdf')
  })

  it('sanitizes traversal in explicit filenames', () => {
    expect(resolveDownloadFilename({
      explicit: '../../.ssh/authorized_keys',
      url: 'https://example.com/x',
      contentDisposition: null,
      contentType: null,
    })).toBe('authorized_keys')
  })
})

describe('extensionForContentType', () => {
  it('maps common types case-insensitively', () => {
    expect(extensionForContentType('image/PNG')).toBe('.png')
    expect(extensionForContentType('application/pdf')).toBe('.pdf')
    expect(extensionForContentType('application/x-unknown')).toBeNull()
    expect(extensionForContentType(null)).toBeNull()
  })
})

describe('parseDataUrl', () => {
  it('decodes base64 data URLs with a content type', () => {
    const parsed = parseDataUrl('data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'))
    expect(parsed).not.toBeNull()
    expect(parsed!.buffer.toString('utf8')).toBe('png-bytes')
    expect(parsed!.contentType).toBe('image/png')
  })

  it('decodes percent-encoded data URLs without a content type', () => {
    const parsed = parseDataUrl('data:,hello%20world')
    expect(parsed).not.toBeNull()
    expect(parsed!.buffer.toString('utf8')).toBe('hello world')
    expect(parsed!.contentType).toBeNull()
  })

  it('returns null for malformed data URLs', () => {
    expect(parseDataUrl('data:no-comma')).toBeNull()
  })
})

describe('writeDownloadFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-download-test-'))
  })

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true })
  })

  it('writes into the directory, creating it if needed', async () => {
    const nested = path.join(dir, 'downloads')
    const saved = await writeDownloadFile(nested, 'photo.jpg', Buffer.from('abc'))
    expect(saved).toBe(path.join(nested, 'photo.jpg'))
    expect(await fs.promises.readFile(saved, 'utf8')).toBe('abc')
  })

  it('suffixes instead of clobbering existing files', async () => {
    const first = await writeDownloadFile(dir, 'photo.jpg', Buffer.from('one'))
    const second = await writeDownloadFile(dir, 'photo.jpg', Buffer.from('two'))
    expect(second).toBe(path.join(dir, 'photo-1.jpg'))
    expect(await fs.promises.readFile(first, 'utf8')).toBe('one')
    expect(await fs.promises.readFile(second, 'utf8')).toBe('two')
  })
})

describe('runBrowserDownload validation paths', () => {
  const baseOptions = {
    validateSession: () => null,
    isBrowserActive: () => true,
    getConnectionUrl: () => 'ws://never-connected',
    getActiveTargetUrl: async () => null,
    urlsMatch: () => false,
  }

  it('rejects invalid request bodies', async () => {
    const result = await runBrowserDownload({ sessionId: 's1' }, baseOptions)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('rejects when another session owns the browser', async () => {
    const result = await runBrowserDownload(
      { sessionId: 's1', url: 'https://example.com/a.png' },
      { ...baseOptions, validateSession: () => 'Browser is owned by session other' }
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.status).toBe(409)
      expect(result.body.error).toContain('owned by session')
    }
  })

  it('rejects when the browser is not active', async () => {
    const result = await runBrowserDownload(
      { sessionId: 's1', url: 'https://example.com/a.png' },
      { ...baseOptions, isBrowserActive: () => false }
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.status).toBe(400)
  })

  it('rejects unsupported URL schemes', async () => {
    const result = await runBrowserDownload(
      { sessionId: 's1', url: 'file:///etc/passwd' },
      baseOptions
    )
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.status).toBe(400)
      expect(result.body.error).toContain('Unsupported URL scheme')
    }
  })

  it('saves data: URLs without a browser connection', async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'browser-download-data-'))
    try {
      const result = await runBrowserDownload(
        {
          sessionId: 's1',
          url: 'data:image/png;base64,' + Buffer.from('fake-png').toString('base64'),
          filename: 'pixel.png',
        },
        { ...baseOptions, downloadsDir: dir }
      )
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.body.file.name).toBe('pixel.png')
        expect(result.body.file.size).toBe(8)
        expect(result.body.file.contentType).toBe('image/png')
        expect(await fs.promises.readFile(result.body.file.path, 'utf8')).toBe('fake-png')
      }
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects empty data: URL payloads', async () => {
    const result = await runBrowserDownload(
      { sessionId: 's1', url: 'data:image/png;base64,' },
      baseOptions
    )
    expect(result.success).toBe(false)
    if (!result.success) expect(result.body.error).toContain('0 bytes')
  })
})
