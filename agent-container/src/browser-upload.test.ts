import * as fs from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUploadFilePayload,
  guessMimeType,
  parseBrowserUploadRequest,
  resolveUploadPath,
  validateUploadVerification,
} from './browser-upload'

afterEach(() => {
  vi.restoreAllMocks()
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

  it('rejects absolute upload paths outside the workspace', () => {
    expect(() => resolveUploadPath('/tmp/file.txt')).toThrow()
  })

  it('guesses common mime types', () => {
    expect(guessMimeType('/tmp/file.txt')).toBe('text/plain')
    expect(guessMimeType('/tmp/file.PNG')).toBe('image/png')
    expect(guessMimeType('/tmp/file.bin')).toBe('application/octet-stream')
  })

  it('creates a Playwright file payload with the real file bytes', async () => {
    // Path confinement (SUP-203) requires the upload to live under /workspace,
    // so mock fs rather than writing to os.tmpdir() (which is now rejected).
    const filePath = '/workspace/uploads/upload.txt'
    const fileBytes = Buffer.from('hello upload')
    const statSpy = vi.spyOn(fs.promises, 'stat').mockResolvedValue({
      isFile: () => true,
      size: fileBytes.length,
    } as unknown as fs.Stats)
    const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue(fileBytes)

    const payload = await createUploadFilePayload(filePath)

    expect(payload.name).toBe('upload.txt')
    expect(payload.mimeType).toBe('text/plain')
    expect(payload.size).toBe(12)
    expect(payload.buffer.toString('utf8')).toBe('hello upload')
    expect(payload.resolvedPath).toBe(filePath)
    expect(statSpy).toHaveBeenCalledWith(filePath)
    expect(readFileSpy).toHaveBeenCalledWith(filePath)
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
