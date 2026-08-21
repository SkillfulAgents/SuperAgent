import { beforeEach, describe, expect, it, vi } from 'vitest'

const cookies = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}))

vi.mock('electron', () => ({
  session: { defaultSession: { cookies } },
}))

import {
  clearCloudDashboardCookie,
  hasCloudDashboardCookie,
  parseSessionSetCookie,
  plantCloudDashboardCookie,
  sessionCookieNameForOrigin,
} from './cloud-dashboard-cookie'

const LINE =
  '__Secure-better-auth.session_token=abc.sig; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=None'

describe('parseSessionSetCookie', () => {
  it('keeps the signed value and requires the embed attributes', () => {
    const parsed = parseSessionSetCookie(LINE)
    expect(parsed).toMatchObject({
      name: '__Secure-better-auth.session_token',
      value: 'abc.sig',
      httpOnly: true,
      secure: true,
      sameSiteNone: true,
      path: '/',
      maxAgeSec: 3600,
    })
  })

  it('rejects a missing Secure or SameSite=None', () => {
    expect(parseSessionSetCookie('better-auth.session_token=x; Path=/; HttpOnly; SameSite=Lax')).toMatchObject({
      sameSiteNone: false,
    })
  })
})

describe('plantCloudDashboardCookie', () => {
  beforeEach(() => {
    cookies.get.mockReset()
    cookies.set.mockReset()
    cookies.remove.mockReset()
  })

  it('translates Max-Age and omits domain', async () => {
    const planted = await plantCloudDashboardCookie('https://ws.example.com', [LINE])
    expect(planted).toBe(true)
    expect(cookies.set).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://ws.example.com/',
        name: '__Secure-better-auth.session_token',
        value: 'abc.sig',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'no_restriction',
      }),
    )
    const details = cookies.set.mock.calls[0][0] as { expirationDate: number; domain?: string }
    expect(details.domain).toBeUndefined()
    expect(details.expirationDate).toBeGreaterThan(Date.now() / 1000)
  })

  it('does not plant a Lax cookie', async () => {
    const planted = await plantCloudDashboardCookie('https://ws.example.com', [
      '__Secure-better-auth.session_token=x; Max-Age=60; Path=/; HttpOnly; Secure; SameSite=Lax',
    ])
    expect(planted).toBe(false)
    expect(cookies.set).not.toHaveBeenCalled()
  })

  it('reports presence and clears by name', async () => {
    cookies.get.mockResolvedValue([{ name: '__Secure-better-auth.session_token', value: 'x' }])
    expect(sessionCookieNameForOrigin('https://ws.example.com')).toBe('__Secure-better-auth.session_token')
    await expect(hasCloudDashboardCookie('https://ws.example.com')).resolves.toBe(true)
    await clearCloudDashboardCookie('https://ws.example.com')
    expect(cookies.remove).toHaveBeenCalledWith(
      'https://ws.example.com/',
      '__Secure-better-auth.session_token',
    )
  })
})
