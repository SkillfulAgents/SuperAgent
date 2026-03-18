import type { MiddlewareHandler } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { isAuthMode } from '@shared/lib/auth/mode'

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function LocalModeAuth(): MiddlewareHandler {
  return async (c, next) => {
    if (isAuthMode()) return next()

    const addr = getConnInfo(c).remote.address
    if (!addr || !LOCALHOST_ADDRS.has(addr)) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    return next()
  }
}
