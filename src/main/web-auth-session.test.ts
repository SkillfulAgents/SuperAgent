import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/nonexistent' } }))

import {
  appleSignInSheetUrl,
  isPlatformLoginUrl,
  parseAppleSignInResult,
  parseWebAuthResult,
  runAppleSignIn,
  runWebAuthSession,
} from './web-auth-session'

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

  it('reads the Apple prompt’s three results, and anything else as an error', () => {
    expect(parseAppleSignInResult('{"idToken":"t","nonce":"n"}')).toEqual({ idToken: 't', nonce: 'n' })
    expect(parseAppleSignInResult('{"cancelled":true}')).toEqual({ cancelled: true })
    expect(parseAppleSignInResult('{"error":"no window"}')).toEqual({ error: 'no window' })

    expect(parseAppleSignInResult('{"idToken":"t"}')).toHaveProperty('error')
    expect(parseAppleSignInResult(null)).toHaveProperty('error')
  })

  it('sends Apple’s answer to the platform’s Apple sign-in page, which continues to the same login URL', async () => {
    const sheet = await appleSignInSheetUrl(
      `${BASE}/auth/superagent?app_callback=superagent%3A%2F%2Fplatform-auth-callback&device_name=Mac`,
      () => true,
      async () => ({ idToken: 'tok.en.sig', nonce: 'raw+nonce/=', name: 'Ada Lovelace' }),
    )
    const url = new URL('url' in sheet ? sheet.url : '')

    expect(url.origin + url.pathname).toBe(`${BASE}/auth/apple/mac`)
    expect(url.searchParams.get('next')).toBe('/auth/superagent?app_callback=superagent%3A%2F%2Fplatform-auth-callback&device_name=Mac')
    const fragment = new URLSearchParams(url.hash.slice(1))
    expect(fragment.get('id_token')).toBe('tok.en.sig')
    expect(fragment.get('nonce')).toBe('raw+nonce/=')
    expect(fragment.get('name')).toBe('Ada Lovelace')
  })

  it('opens no sheet for an attempt cancelled while the Apple prompt was up', async () => {
    let current = true
    let answer!: (value: { idToken: string; nonce: string }) => void
    const pending = appleSignInSheetUrl(`${BASE}/auth/superagent`, () => current, () => new Promise((resolve) => { answer = resolve }))
    current = false
    answer({ idToken: 't', nonce: 'n' })
    await expect(pending).resolves.toEqual({ cancelled: true })
    await expect(appleSignInSheetUrl(`${BASE}/auth/superagent`, () => true, async () => ({ cancelled: true as const })))
      .resolves.toEqual({ cancelled: true })
  })

  it('passes a failed Apple prompt or a missing bridge on as an error', async () => {
    await expect(appleSignInSheetUrl(`${BASE}/auth/superagent`, () => true, async () => ({ error: 'no window' })))
      .resolves.toEqual({ error: 'no window' })
    await expect(appleSignInSheetUrl(`${BASE}/auth/superagent`, () => true, async () => null)).resolves.toHaveProperty('error')
  })

  it('has no Apple prompt to run where the bridge was never built', async () => {
    await expect(runAppleSignIn()).resolves.toBeNull()
  })
})
