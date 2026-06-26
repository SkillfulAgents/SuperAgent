import { describe, it, expect } from 'vitest'
import { signDashboardCookie, verifyDashboardCookie } from './dashboard-cookie'

const SECRET = 'server-secret'
const base = { userId: 'u1', agentSlug: 'sales', dashboardSlug: 'weekly-report', integrationId: 'int1' }

describe('dashboard cookie', () => {
  it('round-trips a valid payload', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie({ ...base, exp }, SECRET)
    expect(await verifyDashboardCookie(token, SECRET)).toMatchObject(base)
  })

  it('rejects a wrong secret', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie({ ...base, exp }, SECRET)
    expect(await verifyDashboardCookie(token, 'other')).toBeNull()
  })

  it('rejects an expired payload', async () => {
    const exp = Math.floor(Date.now() / 1000) - 1
    const token = await signDashboardCookie({ ...base, exp }, SECRET)
    expect(await verifyDashboardCookie(token, SECRET)).toBeNull()
  })

  it('rejects a tampered signature', async () => {
    const exp = Math.floor(Date.now() / 1000) + 900
    const token = await signDashboardCookie({ ...base, exp }, SECRET)
    const [header, body] = token.split('.')
    expect(await verifyDashboardCookie(`${header}.${body}.deadbeef`, SECRET)).toBeNull()
  })
})
