import { z } from 'zod'
import type { CodeSource, LoginFieldKind } from '@shared/lib/tools/request-login/login-request'

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

/**
 * The key a field fills from: its part, or `totp` for a code the page asks
 * for from an authenticator app, which the vault makes from the account's
 * seed when it holds one. Never what a field saves: a code is used once.
 */
export function fillKeyOf(field: { kind: LoginFieldKind; label: string; from?: CodeSource }): string | null {
  if (field.kind === 'otp') return field.from === 'authenticator_app' ? TOTP_FILL_KEY : null
  return partKeyOf(field)
}

/** The fill key of an authenticator app's current code. */
export const TOTP_FILL_KEY = 'totp'

export const TOTP_ALGORITHMS = ['SHA1', 'SHA256', 'SHA512'] as const

/**
 * An authenticator app's seed (RFC 6238): the host makes the code and fills
 * it like any part. `secret` is base32, upper case, without padding.
 */
export const totpSeedSchema = z.object({
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  algorithm: z.enum(TOTP_ALGORITHMS),
  digits: z.number().int().min(6).max(8),
  period: z.number().int().min(15).max(120),
}).strict()
export type TotpSeed = z.infer<typeof totpSeedSchema>

/** A passkey registered through the WebAuthn virtual authenticator (part 4). */
export const passkeySchema = z.object({
  credentialId: z.string().max(1024),
  rpId: z.string().max(253),
  userHandle: z.string().max(1024).optional(),
  /** PKCS#8, base64. */
  privateKey: z.string().max(8192),
  signCount: z.number().int().min(0),
  /** As the site named the account when it created the passkey. */
  userName: z.string().max(320).optional(),
  userDisplayName: z.string().max(320).optional(),
}).strict()
export type Passkey = z.infer<typeof passkeySchema>

export const accountSecretsSchema = z.object({
  /** Saved parts by key (partKeyOf). */
  values: z.record(partKeySchema, z.string().max(MAX_VALUE)),
  /** The authenticator app an agent added for the account (`signInMethods.authenticator` says so in plain text). */
  totp: totpSeedSchema.optional(),
  passkeys: z.array(passkeySchema).max(20).optional(),
}).strict()
export type AccountSecrets = z.infer<typeof accountSecretsSchema>

/** The part keys a row lists in plain text (never values). */
export const accountPartsSchema = z.array(partKeySchema).max(MAX_PARTS)

/** Timestamps in `signInMethods` are milliseconds since the epoch. */
const msSchema = z.number().int().min(0)

/**
 * What a row says in plain text about the account's sign-in methods beyond
 * its parts (never a secret): the authenticator app the vault holds, and
 * whether the owner asked agents to add one. The seed itself is in `secrets`.
 */
export const signInMethodsSchema = z.object({
  authenticator: z.object({
    addedAt: msSchema,
    /** As the site's setup named it ("GitHub", "octocat"), when it did. */
    issuer: z.string().max(200).nullable(),
    accountName: z.string().max(320).nullable(),
    /** What the agent named it on the site, when the site asked ("Gamut"): how a list of apps at sign-in shows it. */
    name: z.string().max(64).nullable().optional(),
    /** An agent said the site rejected a code the vault filled: the user is asked for codes until one is added again. */
    rejectedAt: msSchema.optional(),
  }).strict().optional(),
  /**
   * The passkeys the vault holds for it (their private keys are in `secrets`):
   * the site (`rpId`) each works on, and its names, never a key.
   */
  passkeys: z.array(z.object({
    credentialId: z.string().max(1024),
    rpId: z.string().max(253),
    addedAt: msSchema,
    /** What the agent named it on the site, when the site asked ("Gamut"). */
    name: z.string().max(64).nullable(),
    /** The account name the site gave it. */
    userName: z.string().max(320).nullable(),
  }).strict()).max(20).optional(),
  /**
   * The owner asked agents to add a sign-in method: in the sign-in card, or in
   * Settings → Logins. `askedIn`: the session last asked, as the owner's message.
   */
  requested: z.object({ at: msSchema, from: z.enum(['card', 'logins']), askedIn: z.string().max(200).optional() }).strict().optional(),
  /** An agent found none it may add on the site (two-step verification is off, or adding one would replace another): why, in its words. */
  unavailable: z.object({ at: msSchema, reason: z.string().max(500) }).strict().optional(),
}).strict()
export type SignInMethods = z.infer<typeof signInMethodsSchema>


// ── Saved sessions ─────────────────────────────────────────────────────────
// An account's cookies and web storage on its site, captured from the
// browser after a sign-in (the container's browser-session-schema.ts holds
// the same shape; a contract test keeps the two together).

/** The browser types a saved session restores into: only the type it came from. */
export const BROWSER_TYPES = ['container', 'chrome', 'browserbase', 'platform'] as const
export type BrowserType = (typeof BROWSER_TYPES)[number]

const sessionOriginSchema = z.string().max(300).refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'must be an http(s) origin')

const sessionCookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(8192),
  domain: z.string().min(1).max(260),
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

const indexedDbSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(z.object({
    name: z.string(),
    keyPath: keyPathSchema.nullable(),
    autoIncrement: z.boolean(),
    indexes: z.array(z.object({ name: z.string(), keyPath: keyPathSchema, unique: z.boolean(), multiEntry: z.boolean() }).strict()),
    records: z.array(z.object({ key: z.unknown(), value: z.unknown() }).strict()),
  }).strict()),
}).strict()

export const sessionBundleSchema = z.object({
  version: z.literal(1),
  site: z.string().min(1).max(260),
  capturedAt: z.string().max(40),
  cookies: z.array(sessionCookieSchema).max(3000),
  origins: z.array(z.object({
    origin: sessionOriginSchema,
    localStorage: z.array(z.tuple([z.string(), z.string()])).max(10_000),
    indexedDB: z.array(indexedDbSchema).max(100),
  }).strict()).max(50),
  /** Values and databases left out for their size, or that could not be read. */
  leftOut: z.number().int().min(0).optional(),
}).strict()
export type SessionBundle = z.infer<typeof sessionBundleSchema>
