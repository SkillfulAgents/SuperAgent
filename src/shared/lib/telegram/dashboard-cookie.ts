import { SignJWT, jwtVerify } from 'jose'
import { dashboardCookiePayloadSchema, type DashboardCookiePayload } from './dashboard-cookie-schema'

export { DASHBOARD_COOKIE_NAME, DASHBOARD_COOKIE_TTL_SECONDS } from './dashboard-cookie-schema'

const ALG = 'HS256'

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signDashboardCookie(
  payload: DashboardCookiePayload,
  secret: string,
): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg: ALG }).sign(secretKey(secret))
}

export async function verifyDashboardCookie(
  value: string,
  secret: string,
): Promise<DashboardCookiePayload | null> {
  let claims: unknown
  try {
    // jose validates the HMAC signature and the `exp` claim, throwing on either.
    claims = (await jwtVerify(value, secretKey(secret), { algorithms: [ALG] })).payload
  } catch {
    return null
  }
  const parsed = dashboardCookiePayloadSchema.safeParse(claims)
  return parsed.success ? parsed.data : null
}
