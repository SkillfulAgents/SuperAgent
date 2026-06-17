import { describe, it, expect } from 'vitest'
import { signDashboardCookie, verifyDashboardCookie } from './dashboard-cookie'

const SECRET = 'server-secret'
const base = { userId: 'u1', agentSlug: 'sales', integrationId: 'int1' }

describe('dashboard cookie', () => {
  it('round-trips a valid payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = signDashboardCookie({ ...base, exp }, SECRET)
    expect(verifyDashboardCookie(token, SECRET)).toMatchObject(base)
  })

  it('rejects a wrong secret', () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = signDashboardCookie({ ...base, exp }, SECRET)
    expect(verifyDashboardCookie(token, 'other')).toBeNull()
  })

  it('rejects an expired payload', () => {
    const exp = Math.floor(Date.now() / 1000) - 1
    const token = signDashboardCookie({ ...base, exp }, SECRET)
    expect(verifyDashboardCookie(token, SECRET)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = signDashboardCookie({ ...base, exp }, SECRET)
    const [body] = token.split('.')
    expect(verifyDashboardCookie(`${body}.deadbeef`, SECRET)).toBeNull()
  })
})
