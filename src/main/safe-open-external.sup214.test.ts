import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron so the helper can import { shell } without a real Electron runtime.
// `vi.hoisted` keeps the spy reference valid inside the hoisted vi.mock factory.
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => true) }))
vi.mock('electron', () => ({
  shell: { openExternal },
}))

import { safeOpenExternal, safeOpenExternalFromApp, isSafeExternalUrl } from './safe-open-external'

describe('SUP-214: safeOpenExternal scheme allowlist', () => {
  beforeEach(() => {
    openExternal.mockClear()
  })

  describe('allowed schemes reach shell.openExternal (popup path)', () => {
    // http/https + the user-confirmed communication composers (mailto/sms/tel).
    const allowed = [
      'https://example.com',
      'http://localhost:3000/oauth/callback', // OAuth / localhost redirects
      'mailto:hello@example.com',
      'sms:+15551234&body=hi', // composer; user still confirms send
      'tel:+15551234', // dialer; user still confirms call
    ]
    for (const url of allowed) {
      it(`opens ${url}`, async () => {
        const ok = await safeOpenExternal(url)
        expect(ok).toBe(true)
        expect(openExternal).toHaveBeenCalledTimes(1)
        expect(openExternal).toHaveBeenCalledWith(url)
      })
    }
  })

  describe('unsafe schemes are rejected and never reach shell.openExternal', () => {
    const unsafe = [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'myapp://do-something-privileged',
      'vbscript:msgbox(1)',
      'ftp://example.com/payload',
      // x-apple.systempreferences: is first-party-only (app UI). The popup path
      // rejects it even though safeOpenExternalFromApp allows it.
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
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

  describe('safeOpenExternalFromApp (first-party app UI) allows OS user-action deep-links', () => {
    const allowed = [
      'https://example.com',
      'mailto:hi@example.com',
      'sms:+15551234&body=%2Fsetup', // iMessage setup link
      'tel:+15551234',
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility', // computer-use helper
    ]
    for (const url of allowed) {
      it(`forwards ${url}`, async () => {
        const ok = await safeOpenExternalFromApp(url)
        expect(ok).toBe(true)
        expect(openExternal).toHaveBeenCalledWith(url)
      })
    }

    const stillBlocked = [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'myapp://do-something-privileged',
      'vbscript:msgbox(1)',
    ]
    for (const url of stillBlocked) {
      it(`still rejects ${url}`, async () => {
        const ok = await safeOpenExternalFromApp(url)
        expect(ok).toBe(false)
        expect(openExternal).not.toHaveBeenCalled()
      })
    }
  })

  describe('isSafeExternalUrl mirrors the Zod-validated allowlist', () => {
    it('returns true for the popup-allowlisted schemes (web + communication composers)', () => {
      expect(isSafeExternalUrl('https://example.com')).toBe(true)
      expect(isSafeExternalUrl('http://example.com')).toBe(true)
      expect(isSafeExternalUrl('mailto:hi@example.com')).toBe(true)
      expect(isSafeExternalUrl('sms:+15551234')).toBe(true)
      expect(isSafeExternalUrl('tel:+15551234')).toBe(true)
    })

    it('returns false for unsafe schemes, app-only schemes, and garbage', () => {
      expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
      expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
      expect(isSafeExternalUrl('myapp://x')).toBe(false)
      expect(isSafeExternalUrl('x-apple.systempreferences:com.apple.x')).toBe(false) // app-only
      expect(isSafeExternalUrl('')).toBe(false)
      expect(isSafeExternalUrl(null)).toBe(false)
      expect(isSafeExternalUrl(undefined)).toBe(false)
      expect(isSafeExternalUrl(123)).toBe(false)
    })
  })
})
