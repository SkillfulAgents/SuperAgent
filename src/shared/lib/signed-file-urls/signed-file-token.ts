/**
 * The signed file token: `<payload>.<signature>`, both base64url, so it sits in
 * a URL path segment unescaped. The payload is the JSON of a
 * `SignedFileTokenPayload`; the signature is HMAC-SHA256 over a fixed label
 * and the encoded payload, under a secret created once per deployment (an app
 * record). Verification is stateless: the signature, then the payload's
 * schema (its version included), then its expiry. The payload is readable by
 * whoever holds the token, so it carries ids and a path, never a secret.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { getOrCreateRecord } from '@shared/lib/app-records/records'
import { SIGNED_FILE_URL_SECRET_RECORD_KEY, signedFileUrlSecretRecordSchema } from '@shared/lib/app-records/record-schemas'
import { SIGNED_FILE_CLOCK_SKEW_MS, signedFileTokenPayloadSchema, type SignedFileTokenPayload } from './signed-file-url-schema'

/** Domain separation: this key signs nothing else, but the label keeps it that way if it ever does. */
const SIGNATURE_LABEL = 'gamut:signed-file-url:'
/** A base64url SHA-256 MAC. */
const SIGNATURE_LENGTH = 43
/** Far above any payload this module signs; refuses a giant token before any work. */
const MAX_TOKEN_LENGTH = 8192
const BASE64URL = /^[A-Za-z0-9_-]+$/

async function signingKey(): Promise<Buffer> {
  const secret = await getOrCreateRecord(SIGNED_FILE_URL_SECRET_RECORD_KEY, signedFileUrlSecretRecordSchema, () =>
    randomBytes(32).toString('base64url'))
  return Buffer.from(secret, 'utf8')
}

function mac(key: Buffer, encodedPayload: string): Buffer {
  return createHmac('sha256', key).update(SIGNATURE_LABEL).update(encodedPayload).digest()
}

/** A fresh token id. */
export function newTokenId(): string {
  return randomBytes(18).toString('base64url')
}

export async function signFileToken(payload: SignedFileTokenPayload): Promise<string> {
  // What is signed is exactly what verify accepts.
  const encoded = Buffer.from(JSON.stringify(signedFileTokenPayloadSchema.parse(payload)), 'utf8').toString('base64url')
  return `${encoded}.${mac(await signingKey(), encoded).toString('base64url')}`
}

export type TokenVerification =
  | { ok: true; payload: SignedFileTokenPayload }
  | { ok: false; reason: 'invalid' | 'expired' }

/** The token's payload when it is ours, unchanged, unexpired and not issued in the future. */
export async function verifyFileToken(token: string, now: number = Date.now()): Promise<TokenVerification> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: 'invalid' }
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return { ok: false, reason: 'invalid' }
  const encoded = token.slice(0, dot)
  const signature = token.slice(dot + 1)
  if (!BASE64URL.test(encoded) || signature.length !== SIGNATURE_LENGTH || !BASE64URL.test(signature)) {
    return { ok: false, reason: 'invalid' }
  }
  // Compared as text, so a signature spelled differently that decodes to the same bytes is refused too.
  const expected = Buffer.from(mac(await signingKey(), encoded).toString('base64url'), 'utf8')
  const given = Buffer.from(signature, 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const payload = signedFileTokenPayloadSchema.safeParse(parsed)
  if (!payload.success) return { ok: false, reason: 'invalid' }
  if (payload.data.exp <= now) return { ok: false, reason: 'expired' }
  // Nothing mints ahead of time: an issue time from the future is not a token we made.
  if (payload.data.iat > now + SIGNED_FILE_CLOCK_SKEW_MS) return { ok: false, reason: 'invalid' }
  return { ok: true, payload: payload.data }
}
