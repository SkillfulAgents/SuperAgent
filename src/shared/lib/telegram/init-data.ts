import { validate } from '@tma.js/init-data-node'

type Result =
  | { ok: true; data: { user?: { id: number } } }
  | { ok: false; reason: 'signature' | 'stale' | 'malformed' }

/**
 * verifyInitData — verify a Telegram Mini App `initData` blob and extract the
 * Telegram user id. The HMAC verification and freshness check are delegated to
 * @tma.js/init-data-node (`validate`); this function is the stable seam the rest
 * of the app depends on, keeping the vendor swappable.
 *
 * We deliberately do NOT use the library's `parse()`: it additionally requires a
 * Bot API 8.0 `signature` field and a full Telegram `User` shape. We only need
 * the user id, and `validate()` has already proven the blob is authentic, so we
 * read the id directly and stay uncoupled from that evolving schema.
 */
export function verifyInitData(initData: string, botToken: string, maxAgeSeconds: number): Result {
  try {
    validate(initData, botToken, { expiresIn: maxAgeSeconds })
  } catch (e) {
    // The library's exported error classes do NOT satisfy `instanceof` against the
    // instances it throws (a dual class-identity quirk), so discriminate on the
    // stable error name — `instanceof` would silently map everything to `malformed`.
    const name = e instanceof Error ? e.name : ''
    if (name === 'ExpiredError') return { ok: false, reason: 'stale' }
    if (name === 'SignatureInvalidError' || name === 'HexStringLengthInvalidError') {
      return { ok: false, reason: 'signature' }
    }
    // SignatureMissingError, AuthDateInvalidError, etc. → malformed input
    return { ok: false, reason: 'malformed' }
  }

  const rawUser = new URLSearchParams(initData).get('user')
  if (!rawUser) return { ok: true, data: {} }
  try {
    const parsed: unknown = JSON.parse(rawUser)
    const id = (parsed as { id?: unknown })?.id
    return { ok: true, data: typeof id === 'number' ? { user: { id } } : {} }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
}
