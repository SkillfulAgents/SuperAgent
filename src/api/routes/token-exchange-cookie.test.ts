import { describe, expect, it } from 'vitest'
import { isDesktopCookieCaller } from './token-exchange-cookie'

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init)
}

describe('isDesktopCookieCaller', () => {
  it('allows a main-process POST with no browser headers', () => {
    expect(isDesktopCookieCaller(headers())).toBe(true)
  })

  it('rejects a browser Origin', () => {
    expect(isDesktopCookieCaller(headers({ origin: 'https://app.example.com' }))).toBe(false)
  })

  it('rejects document and iframe fetch metadata', () => {
    expect(isDesktopCookieCaller(headers({ 'sec-fetch-dest': 'document' }))).toBe(false)
    expect(isDesktopCookieCaller(headers({ 'sec-fetch-dest': 'iframe' }))).toBe(false)
    expect(isDesktopCookieCaller(headers({ 'sec-fetch-dest': 'embed' }))).toBe(false)
    expect(isDesktopCookieCaller(headers({ 'sec-fetch-dest': 'frame' }))).toBe(false)
    expect(isDesktopCookieCaller(headers({ 'sec-fetch-mode': 'navigate' }))).toBe(false)
  })
})
