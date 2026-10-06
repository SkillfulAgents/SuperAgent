// The saved-login bundle format, shared by the container and the host vault.
import { z } from 'zod'

export const siteSchema = z.string().max(253).regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'site must be a lowercase registrable domain')

export const originSchema = z.string().max(2048).refine((value) => {
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

/** What identifies a cookie in the browser's jar, without its value. */
export const cookieKeySchema = cookieSchema.pick({ name: true, domain: true, path: true, partitionKey: true })

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
  /** Only present when a tab of this origin was open at capture time. */
  sessionStorage: entriesSchema.optional(),
  /** IndexedDB databases left out for exceeding MAX_INDEXEDDB_DATABASE_CHARS. */
  oversizedDatabases: z.array(z.string()).optional(),
  /** Value types that cannot leave the browser (e.g. non-extractable CryptoKey). */
  unsupported: z.array(z.string()),
}).strict()

export const siteStorageBundleSchema = z.object({
  version: z.literal(1),
  site: siteSchema,
  capturedAt: z.string(),
  cookies: z.array(cookieSchema).max(5000),
  origins: z.array(originStorageSchema).max(100),
}).strict()

export type StorageCookie = z.infer<typeof cookieSchema>
export type StorageCookieKey = z.infer<typeof cookieKeySchema>
export type OriginStorage = z.infer<typeof originStorageSchema>
export type SiteStorageBundle = z.infer<typeof siteStorageBundleSchema>
