import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyInitData } from './init-data'

const BOT_TOKEN = '123456:TEST'

// Build a correctly-signed initData string for a given auth_date.
function signInitData(fields: Record<string, string>): string {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join('\n')
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest()
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex')
  const params = new URLSearchParams({ ...fields, hash })
  return params.toString()
}

describe('verifyInitData', () => {
  it('accepts a valid, fresh initData', () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({
      auth_date: String(authDate),
      user: JSON.stringify({ id: 42, username: 'alice' }),
    })
    const res = verifyInitData(initData, BOT_TOKEN, 86400)
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data.user?.id).toBe(42)
  })

  it('rejects a tampered hash', () => {
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) })
      .replace(/hash=[a-f0-9]+/, 'hash=deadbeef')
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('rejects stale initData beyond maxAge', () => {
    const authDate = Math.floor(Date.now() / 1000) - 100000
    const initData = signInitData({ auth_date: String(authDate) })
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'stale' })
  })

  it('returns malformed (not throws) when user field is invalid JSON despite valid HMAC', () => {
    const authDate = Math.floor(Date.now() / 1000)
    const initData = signInitData({ auth_date: String(authDate), user: 'not{json' })
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('returns malformed when auth_date is not a finite number', () => {
    // Number('notanumber') === NaN; z.number().finite() must reject it so the
    // freshness check can't be silently bypassed.
    const initData = signInitData({ auth_date: 'notanumber', user: JSON.stringify({ id: 1 }) })
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('returns malformed when the hash field is missing', () => {
    const initData = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)) }).toString()
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'malformed' })
  })

  it('rejects an equal-length but wrong hash (constant-time compare path)', () => {
    // A 64-hex wrong hash has the same length as the real one, so it exercises
    // timingSafeEqual rather than the length short-circuit.
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)) })
      .replace(/hash=[a-f0-9]+/, 'hash=' + 'a'.repeat(64))
    expect(verifyInitData(initData, BOT_TOKEN, 86400)).toMatchObject({ ok: false, reason: 'signature' })
  })
})
