import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createUploadFilePayload,
  guessMimeType,
  parseBrowserUploadRequest,
  resolveUploadPath,
  validateUploadVerification,
} from './browser-upload'

let tmpDir: string | null = null

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    tmpDir = null
  }
})

describe('browser upload helpers', () => {
  it('parses upload requests with the default file input selector', () => {
    expect(parseBrowserUploadRequest({
      sessionId: 'session-1',
      filePath: '/workspace/uploads/file.txt',
    })).toEqual({
      success: true,
      data: {
        sessionId: 'session-1',
        selector: 'input[type="file"]',
        filePath: '/workspace/uploads/file.txt',
      },
    })
  })

  it('rejects upload requests missing a file path', () => {
    const parsed = parseBrowserUploadRequest({ sessionId: 'session-1' })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error).toContain('Invalid input')
    }
  })

  it('resolves relative upload paths under /workspace', () => {
    expect(resolveUploadPath('uploads/file.txt')).toBe('/workspace/uploads/file.txt')
  })

  it('keeps absolute upload paths unchanged', () => {
    expect(resolveUploadPath('/tmp/file.txt')).toBe('/tmp/file.txt')
  })

  it('guesses common mime types', () => {
    expect(guessMimeType('/tmp/file.txt')).toBe('text/plain')
    expect(guessMimeType('/tmp/file.PNG')).toBe('image/png')
    expect(guessMimeType('/tmp/file.bin')).toBe('application/octet-stream')
  })

  it('creates a Playwright file payload with the real file bytes', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-upload-test-'))
    const filePath = path.join(tmpDir, 'upload.txt')
    fs.writeFileSync(filePath, 'hello upload')

    const payload = await createUploadFilePayload(filePath)

    expect(payload.name).toBe('upload.txt')
    expect(payload.mimeType).toBe('text/plain')
    expect(payload.size).toBe(12)
    expect(payload.buffer.toString('utf8')).toBe('hello upload')
    expect(payload.resolvedPath).toBe(filePath)
  })

  it('accepts matching upload verification', () => {
    expect(validateUploadVerification(
      { name: 'upload.txt', size: 12 },
      { count: 1, name: 'upload.txt', size: 12 }
    )).toBeNull()
  })

  it('rejects zero-byte verification for a non-empty file', () => {
    expect(validateUploadVerification(
      { name: 'upload.txt', size: 12 },
      { count: 1, name: 'upload.txt', size: 0 }
    )).toContain('size mismatch')
  })
})
