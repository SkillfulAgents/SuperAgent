import crypto from 'crypto'
import { totpSeedSchema, type TotpSeed } from './vault-schemas'

/**
 * Authenticator-app codes (TOTP, RFC 6238): the setup a site shows as a QR
 * code or a key to type, and the code it asks for at sign-in. The seed is a
 * secret like a password: sealed in the account's `secrets`, read here only to
 * make a code, never to the agent.
 */

export type { TotpSeed }

/** What the setup showed besides the seed: who issued it, and the account name it carries. Neither is secret. */
export interface TotpSetup {
  seed: TotpSeed
  issuer: string | null
  accountName: string | null
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** A key as sites show it ("jbsw y3dp ehpk 3pxp", with or without padding): base32 upper case, or null when it is not one. */
export function normalizeBase32(key: string): string | null {
  const compact = key.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
  return /^[A-Z2-7]+$/.test(compact) ? compact : null
}

function base32Bytes(secret: string): Buffer {
  let bits = 0
  let value = 0
  const bytes: number[] = []
  for (const char of secret) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}

/** The code for the period holding `atMs` (HOTP over the period's counter, RFC 4226 truncation). */
export function totpCode(seed: TotpSeed, atMs: number): string {
  const counter = Math.floor(atMs / 1000 / seed.period)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac(seed.algorithm.toLowerCase(), base32Bytes(seed.secret)).update(message).digest()
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(binary % 10 ** seed.digits).padStart(seed.digits, '0')
}

/** Milliseconds until the period holding `atMs` ends and its code stops working. */
export function totpMsLeft(seed: TotpSeed, atMs: number): number {
  const periodMs = seed.period * 1000
  return periodMs - (atMs % periodMs)
}

/** Below this much of its period left, a code may expire on its way into the page: the next one is waited for. */
export const TOTP_MIN_MS_LEFT = 3_000

/**
 * A code that will still work by the time the page sends it: the current one,
 * or the next period's when the current is about to run out.
 */
export async function freshTotpCode(seed: TotpSeed, now: () => number = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))): Promise<string> {
  const left = totpMsLeft(seed, now())
  if (left < TOTP_MIN_MS_LEFT) await sleep(left + 200)
  return totpCode(seed, now())
}

/** Seeds shorter than 80 bits are not ones a site would issue: more likely a stray word read as base32. */
const MIN_SECRET_CHARS = 16

/**
 * What a setup QR code or key says: an `otpauth://totp/…` URI, or the bare
 * key the page shows to type ("Can't scan it?"). Null when it is neither, or
 * asks for what the vault does not make (counter-based HOTP, Steam's codes).
 */
export function parseTotpSetup(text: string): TotpSetup | null {
  const trimmed = text.trim()
  if (/^otpauth:/i.test(trimmed)) return parseOtpauthUri(trimmed)
  const secret = normalizeBase32(trimmed)
  if (!secret || secret.length < MIN_SECRET_CHARS) return null
  const seed = totpSeedSchema.safeParse({ secret, algorithm: 'SHA1', digits: 6, period: 30 })
  return seed.success ? { seed: seed.data, issuer: null, accountName: null } : null
}

function parseOtpauthUri(uri: string): TotpSetup | null {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.protocol.toLowerCase() !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') return null
  const params = url.searchParams
  // Steam's and other services' own code alphabets are not RFC 6238 codes.
  if (params.has('encoder')) return null
  const secret = normalizeBase32(params.get('secret') ?? '')
  if (!secret || secret.length < MIN_SECRET_CHARS) return null
  const algorithm = (params.get('algorithm') ?? 'SHA1').toUpperCase()
  const seed = totpSeedSchema.safeParse({
    secret,
    algorithm,
    digits: Number(params.get('digits') ?? 6),
    period: Number(params.get('period') ?? 30),
  })
  if (!seed.success) return null
  let label = ''
  try {
    label = decodeURIComponent(url.pathname.replace(/^\//, ''))
  } catch {
    label = ''
  }
  // The label is "Issuer:account" or "account"; the issuer parameter wins.
  const colon = label.indexOf(':')
  const labelIssuer = colon >= 0 ? label.slice(0, colon).trim() : ''
  const accountName = (colon >= 0 ? label.slice(colon + 1) : label).trim()
  const issuer = (params.get('issuer') ?? labelIssuer).trim()
  return {
    seed: seed.data,
    issuer: issuer ? issuer.slice(0, 200) : null,
    accountName: accountName ? accountName.slice(0, 320) : null,
  }
}
