import crypto from 'node:crypto'
import { dashboardCookiePayloadSchema, type DashboardCookiePayload } from './dashboard-cookie-schema'

export { DASHBOARD_COOKIE_NAME, DASHBOARD_COOKIE_TTL_SECONDS } from './dashboard-cookie-schema'

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

export function signDashboardCookie(payload: DashboardCookiePayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function verifyDashboardCookie(value: string, secret: string): DashboardCookiePayload | null {
  const dot = value.lastIndexOf('.')
  if (dot < 0) return null
  const body = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  if (expected.length !== sig.length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = dashboardCookiePayloadSchema.safeParse(json)
  if (!parsed.success) return null
  if (parsed.data.exp <= Math.floor(Date.now() / 1000)) return null
  return parsed.data
}
