import crypto from 'node:crypto'
import { initDataSchema, type InitData } from './init-data-schema'

// Allow a little clock skew so a server running slightly behind Telegram doesn't
// reject otherwise-valid initData whose auth_date reads as marginally in the future.
const MAX_CLOCK_SKEW_SECONDS = 300

type Result =
  | { ok: true; data: InitData }
  | { ok: false; reason: 'signature' | 'stale' | 'malformed' }

export function verifyInitData(initData: string, botToken: string, maxAgeSeconds: number): Result {
  let params: URLSearchParams
  try {
    params = new URLSearchParams(initData)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const hash = params.get('hash')
  if (!hash) return { ok: false, reason: 'malformed' }

  // data_check_string: every field except hash, sorted by key, "k=v" joined by \n
  const pairs: string[] = []
  for (const [k, v] of params.entries()) {
    if (k === 'hash') continue
    pairs.push(`${k}=${v}`)
  }
  pairs.sort()
  const dcs = pairs.join('\n')

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest()
  const computed = crypto.createHmac('sha256', secret).update(dcs).digest('hex')
  if (computed.length !== hash.length ||
      !crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hash))) {
    return { ok: false, reason: 'signature' }
  }

  const userRaw = params.get('user')
  let userParsed: unknown = undefined
  if (userRaw) {
    try { userParsed = JSON.parse(userRaw) } catch { return { ok: false, reason: 'malformed' } }
  }
  const parsed = initDataSchema.safeParse({
    user: userParsed,
    auth_date: Number(params.get('auth_date')),
    query_id: params.get('query_id') ?? undefined,
    hash,
  })
  if (!parsed.success) return { ok: false, reason: 'malformed' }

  const ageSeconds = Math.floor(Date.now() / 1000) - parsed.data.auth_date
  if (ageSeconds > maxAgeSeconds) return { ok: false, reason: 'stale' }
  // A future auth_date yields a negative age that would otherwise slip past the
  // staleness check; reject anything beyond the small clock-skew allowance.
  if (ageSeconds < -MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: 'stale' }

  return { ok: true, data: parsed.data }
}
