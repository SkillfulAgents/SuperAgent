import { z } from 'zod'

/**
 * A saved session: an account's cookies and web storage on its site, as
 * captured from the browser after a sign-in and written back into another
 * browser of the same type. The host seals it in its vault; it only ever
 * travels between the host and this container's session endpoints.
 */

/** The account's site: its sign-in host without a leading www, port included. */
export const sessionSiteSchema = z.string().min(1).max(260).regex(/^[a-z0-9.-]+(:\d{1,5})?$/)

export const sessionOriginSchema = z.string().max(300).refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}, 'must be an http(s) origin')

/** A cookie with every attribute Storage.setCookies takes. */
const sessionCookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(8192),
  domain: z.string().min(1).max(260),
  path: z.string().max(2048),
  /** Absent for a session cookie. */
  expires: z.number().optional(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
  priority: z.enum(['Low', 'Medium', 'High']).optional(),
  sourceScheme: z.enum(['Unset', 'NonSecure', 'Secure']).optional(),
  sourcePort: z.number().int().optional(),
  partitionKey: z.object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() }).optional(),
}).strict()
export type SessionCookie = z.infer<typeof sessionCookieSchema>

const keyPathSchema = z.union([z.string(), z.array(z.string())])

const indexedDbSchema = z.object({
  name: z.string(),
  version: z.number().int().positive(),
  stores: z.array(z.object({
    name: z.string(),
    keyPath: keyPathSchema.nullable(),
    autoIncrement: z.boolean(),
    indexes: z.array(z.object({ name: z.string(), keyPath: keyPathSchema, unique: z.boolean(), multiEntry: z.boolean() }).strict()),
    /** Keys and values in the page codec's encoding (browser-session-script.ts). */
    records: z.array(z.object({ key: z.unknown(), value: z.unknown() }).strict()),
  }).strict()),
}).strict()

const originStorageSchema = z.object({
  origin: sessionOriginSchema,
  localStorage: z.array(z.tuple([z.string(), z.string()])).max(10_000),
  indexedDB: z.array(indexedDbSchema).max(100),
}).strict()
export type OriginStorage = z.infer<typeof originStorageSchema>

export const sessionBundleSchema = z.object({
  version: z.literal(1),
  site: sessionSiteSchema,
  capturedAt: z.string().max(40),
  cookies: z.array(sessionCookieSchema).max(3000),
  origins: z.array(originStorageSchema).max(50),
  /** Values and databases left out for their size (caches), so the bundle may not hold all of the site's state. */
  leftOut: z.number().int().min(0).optional(),
}).strict()
export type SessionBundle = z.infer<typeof sessionBundleSchema>
