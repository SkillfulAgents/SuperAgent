import { z } from 'zod'
import type { LoginFieldKind } from '@shared/lib/tools/request-login/login-request'

/**
 * What a saved account's sealed column holds, and how its parts are named.
 * Values never leave the host except into a page, through the container's
 * fill endpoint.
 */

const MAX_VALUE = 4096
export const MAX_PARTS = 16

/**
 * The name of the part a sign-in field fills: 'password', or 'text:<label>'
 * for another field the site asks for (a workspace, a company id). Null for
 * what is not a part: the username is the account itself, and a one-time
 * code is used once.
 */
export function partKeyOf(field: { kind: LoginFieldKind; label: string }): string | null {
  if (field.kind === 'password') return 'password'
  if (field.kind === 'text') {
    const label = field.label.toLowerCase().replace(/[\s:*]+$/g, '').replace(/\s+/g, ' ').trim()
    return label ? `text:${label.slice(0, 120)}` : null
  }
  return null
}

export const partKeySchema = z.string().regex(/^(password|text:.{1,120})$/s)

/** A TOTP seed (part 4): the host generates the code and fills it like any part. */
const totpSchema = z.object({
  secret: z.string().max(256),
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']),
  digits: z.number().int().min(6).max(8),
  period: z.number().int().min(15).max(120),
}).strict()

/** A passkey registered through the WebAuthn virtual authenticator (part 4). */
const passkeySchema = z.object({
  credentialId: z.string().max(1024),
  rpId: z.string().max(253),
  userHandle: z.string().max(1024).optional(),
  /** PKCS#8, base64. */
  privateKey: z.string().max(8192),
  signCount: z.number().int().min(0),
}).strict()

export const accountSecretsSchema = z.object({
  /** Saved parts by key (partKeyOf). */
  values: z.record(partKeySchema, z.string().max(MAX_VALUE)),
  totp: totpSchema.optional(),
  passkeys: z.array(passkeySchema).max(20).optional(),
}).strict()
export type AccountSecrets = z.infer<typeof accountSecretsSchema>

/** The part keys a row lists in plain text (never values). */
export const accountPartsSchema = z.array(partKeySchema).max(MAX_PARTS)

// ── Saved sessions (part 3) ────────────────────────────────────────────────
// An account's cookies and web storage, captured after a sign-in. The shape
// follows #1210's capture/restore primitives; part 3 writes and restores it.

const originSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'must be an http(s) origin')

const entriesSchema = z.array(z.tuple([z.string(), z.string()])).max(10_000)

const cookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(16_384),
  domain: z.string().min(1).max(253),
  path: z.string().max(2048),
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']).optional(),
  sourcePort: z.number().int().optional(),
  partitionKey: z.object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() }).optional(),
}).strict()

const keyPathSchema = z.union([z.string(), z.array(z.string())])

const indexedDbDatabaseSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(z.object({
    name: z.string(),
    keyPath: keyPathSchema.nullable(),
    autoIncrement: z.boolean(),
    indexes: z.array(z.object({
      name: z.string(),
      keyPath: keyPathSchema,
      unique: z.boolean(),
      multiEntry: z.boolean(),
    }).strict()),
    records: z.array(z.object({ key: z.unknown(), value: z.unknown() }).strict()),
  }).strict()),
}).strict()

const originStorageSchema = z.object({
  origin: originSchema,
  localStorage: entriesSchema,
  indexedDB: z.array(indexedDbDatabaseSchema).max(100),
  /** Only when a tab of this origin was open at capture time. */
  sessionStorage: entriesSchema.optional(),
  /** Databases left out for their size. */
  oversizedDatabases: z.array(z.string()).optional(),
  /** Value types that cannot leave the browser (a non-extractable CryptoKey). */
  unsupported: z.array(z.string()),
}).strict()

export const sessionBundleSchema = z.object({
  version: z.literal(1),
  site: z.string().max(253),
  capturedAt: z.string(),
  cookies: z.array(cookieSchema).max(5000),
  origins: z.array(originStorageSchema).max(100),
}).strict()
export type SessionBundle = z.infer<typeof sessionBundleSchema>
