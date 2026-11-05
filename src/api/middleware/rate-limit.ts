/**
 * Per-client rate limits, counted in AppState so every process serving the
 * tenant shares them.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { defineFixedWindow } from '@shared/lib/app-state/fixed-window'
import { digestKeyPart } from '@shared/lib/app-state'

/**
 * The client a rate limit counts against, as a key part: the
 * `x-forwarded-for` header as sent (all of it, not only its first address),
 * else `x-real-ip`, else one `unknown` client for every request that sends
 * neither. Digested, so no address is stored in a key.
 */
export function rateLimitClient(c: Context): string {
  return digestKeyPart(c.req.header('x-forwarded-for') || c.req.header('x-real-ip') || 'unknown')
}

/** Auth POSTs (sign-in, sign-up, token exchange, pairing): 100 per client in a 15-minute window. */
export const authAttempts = defineFixedWindow({ name: 'rate:auth', limit: 100, windowMs: 15 * 60_000 })

/**
 * Refuses an auth POST once its client has used up its window. Other methods
 * are not counted. An AppState failure is thrown, so the request fails rather
 * than going through uncounted.
 */
export const authRateLimit: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next()
  const hit = await authAttempts.hit(authAttempts.key(rateLimitClient(c)))
  if (!hit.admitted) return c.json({ error: 'Too many attempts. Please try again later.' }, 429)
  return next()
}
