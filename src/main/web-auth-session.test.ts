import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }))

import { isPlatformLoginUrl, parseWebAuthResult, runWebAuthSession } from './web-auth-session'

const BASE = 'https://platform.example'

describe('the sign-in sheet', () => {
  it('opens only the platform’s own login page', () => {
    expect(isPlatformLoginUrl(`${BASE}/auth/superagent?app_callback=superagent%3A%2F%2Fplatform-auth-callback`, BASE)).toBe(true)
    expect(isPlatformLoginUrl(`${BASE}/auth/superagent`, `${BASE}/`)).toBe(true)

    expect(isPlatformLoginUrl('https://evil.example/auth/superagent', BASE)).toBe(false)
    expect(isPlatformLoginUrl(`${BASE}.evil.example/auth/superagent`, BASE)).toBe(false)
    expect(isPlatformLoginUrl(`${BASE}/dashboard`, BASE)).toBe(false)
    expect(isPlatformLoginUrl(`http://platform.example/auth/superagent`, BASE)).toBe(false)
    expect(isPlatformLoginUrl('superagent://platform-auth-callback', BASE)).toBe(false)
    expect(isPlatformLoginUrl(undefined, BASE)).toBe(false)
    expect(isPlatformLoginUrl(`${BASE}/auth/superagent`, '')).toBe(false)
  })

  it('reads the bridge’s three results, and anything else as an error', () => {
    expect(parseWebAuthResult('{"url":"superagent://platform-auth-callback?token=t"}')).toEqual({
      url: 'superagent://platform-auth-callback?token=t',
    })
    expect(parseWebAuthResult('{"cancelled":true}')).toEqual({ cancelled: true })
    expect(parseWebAuthResult('{"error":"no window"}')).toEqual({ error: 'no window' })

    expect(parseWebAuthResult('{"url":""}')).toHaveProperty('error')
    expect(parseWebAuthResult('not json')).toHaveProperty('error')
    expect(parseWebAuthResult(null)).toHaveProperty('error')
  })

  it('has no session to run where the bridge was never built, so the caller falls back to the browser', async () => {
    await expect(runWebAuthSession(`${BASE}/auth/superagent`, 'superagent')).resolves.toBeNull()
  })
})
