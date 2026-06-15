import * as fs from 'fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUploadFilePayload,
  resolveUploadPath,
  runBrowserUpload,
} from './browser-upload'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SUP-203: browser upload path confinement to /workspace', () => {
  describe('resolveUploadPath rejects paths outside /workspace', () => {
    it('throws for an absolute path outside /workspace', () => {
      expect(() => resolveUploadPath('/tmp/file.txt')).toThrow()
      expect(() => resolveUploadPath('/etc/passwd')).toThrow()
    })

    it('throws for relative ../ traversal that escapes /workspace', () => {
      expect(() => resolveUploadPath('../etc/passwd')).toThrow()
      expect(() => resolveUploadPath('../../root/.ssh/id_rsa')).toThrow()
    })

    it('throws for an absolute /workspace path that normalizes out via ..', () => {
      expect(() => resolveUploadPath('/workspace/../etc/passwd')).toThrow()
    })
  })

  describe('resolveUploadPath accepts in-scope paths', () => {
    it('normalizes a relative in-scope path under /workspace', () => {
      expect(resolveUploadPath('uploads/file.txt')).toBe('/workspace/uploads/file.txt')
    })

    it('keeps an absolute in-scope path unchanged', () => {
      expect(resolveUploadPath('/workspace/uploads/file.txt')).toBe('/workspace/uploads/file.txt')
    })

    it('allows the workspace root itself', () => {
      expect(resolveUploadPath('/workspace')).toBe('/workspace')
    })
  })

  describe('runBrowserUpload surfaces confinement as a clean 400 and never reads the file', () => {
    it('returns status 400 (not a thrown 500) for an out-of-scope filePath and does not read fs', async () => {
      const statSpy = vi.spyOn(fs.promises, 'stat')
      const readFileSpy = vi.spyOn(fs.promises, 'readFile')

      const result = await runBrowserUpload(
        {
          sessionId: 'session-1',
          selector: 'input[type="file"]',
          filePath: '/tmp/secret',
        },
        {
          validateSession: () => null,
          isBrowserActive: () => true,
          getConnectionUrl: () => 'http://127.0.0.1:0',
          getActiveTargetUrl: async () => null,
          urlsMatch: () => true,
        }
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.status).toBe(400)
        expect(result.body.error).toBeTruthy()
      }
      expect(statSpy).not.toHaveBeenCalled()
      expect(readFileSpy).not.toHaveBeenCalled()
    })
  })

  describe('createUploadFilePayload refuses out-of-scope files without reading them', () => {
    it('throws and never reads an out-of-scope absolute path', async () => {
      const statSpy = vi.spyOn(fs.promises, 'stat')
      const readFileSpy = vi.spyOn(fs.promises, 'readFile')

      await expect(createUploadFilePayload('/etc/passwd')).rejects.toThrow()

      expect(statSpy).not.toHaveBeenCalled()
      expect(readFileSpy).not.toHaveBeenCalled()
    })
  })
})
