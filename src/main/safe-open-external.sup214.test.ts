import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron so the helper can import { shell } without a real Electron runtime.
// `vi.hoisted` keeps the spy reference valid inside the hoisted vi.mock factory.
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => true) }))
vi.mock('electron', () => ({
  shell: { openExternal },
}))

import { safeOpenExternal, isSafeExternalUrl } from './safe-open-external'

describe('SUP-214: safeOpenExternal scheme allowlist', () => {
  beforeEach(() => {
    openExternal.mockClear()
  })

  describe('allowed web schemes reach shell.openExternal', () => {
    it('opens https URLs', async () => {
      const ok = await safeOpenExternal('https://example.com')
      expect(ok).toBe(true)
      expect(openExternal).toHaveBeenCalledTimes(1)
      expect(openExternal).toHaveBeenCalledWith('https://example.com')
    })

    it('opens http URLs (allowlisted for OAuth / localhost redirects)', async () => {
      const ok = await safeOpenExternal('http://localhost:3000/oauth/callback')
      expect(ok).toBe(true)
      expect(openExternal).toHaveBeenCalledTimes(1)
      expect(openExternal).toHaveBeenCalledWith('http://localhost:3000/oauth/callback')
    })

    it('opens mailto URLs (allowlisted)', async () => {
      const ok = await safeOpenExternal('mailto:hello@example.com')
      expect(ok).toBe(true)
      expect(openExternal).toHaveBeenCalledTimes(1)
      expect(openExternal).toHaveBeenCalledWith('mailto:hello@example.com')
    })
  })

  describe('unsafe schemes are rejected and never reach shell.openExternal', () => {
    const unsafe = [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'myapp://do-something-privileged',
      'vbscript:msgbox(1)',
      'ftp://example.com/payload',
    ]
    for (const url of unsafe) {
      it(`rejects ${url}`, async () => {
        const ok = await safeOpenExternal(url)
        expect(ok).toBe(false)
        expect(openExternal).not.toHaveBeenCalled()
      })
    }
  })

  describe('non-string / empty / malformed input is rejected without throwing', () => {
    const garbage: unknown[] = ['', '   ', 'not a url', 'https://', null, undefined, 42, {}, [], NaN]
    for (const value of garbage) {
      it(`rejects ${JSON.stringify(value)} without throwing`, async () => {
        let ok: boolean | undefined
        await expect(
          (async () => {
            ok = await safeOpenExternal(value as string)
          })(),
        ).resolves.not.toThrow()
        expect(ok).toBe(false)
        expect(openExternal).not.toHaveBeenCalled()
      })
    }
  })

  describe('isSafeExternalUrl mirrors the Zod-validated allowlist', () => {
    it('returns true only for allowlisted web schemes', () => {
      expect(isSafeExternalUrl('https://example.com')).toBe(true)
      expect(isSafeExternalUrl('http://example.com')).toBe(true)
      expect(isSafeExternalUrl('mailto:hi@example.com')).toBe(true)
    })

    it('returns false for unsafe schemes and garbage', () => {
      expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
      expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
      expect(isSafeExternalUrl('myapp://x')).toBe(false)
      expect(isSafeExternalUrl('')).toBe(false)
      expect(isSafeExternalUrl(null)).toBe(false)
      expect(isSafeExternalUrl(undefined)).toBe(false)
      expect(isSafeExternalUrl(123)).toBe(false)
    })
  })
})
