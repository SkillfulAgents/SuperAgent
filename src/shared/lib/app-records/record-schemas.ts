/**
 * Every app record key and the Zod schema its value is read and written
 * with. Settings keep their own permissive boundary schema
 * (`config/settings-schema.ts`); the identities here are plain strings.
 */
import { z } from 'zod'

export const SETTINGS_RECORD_KEY = 'settings'
export const TENANT_ID_RECORD_KEY = 'tenant-id'
export const AUTH_SECRET_RECORD_KEY = 'auth-secret'
export const PLATFORM_CLIENT_INSTANCE_ID_RECORD_KEY = 'platform-client-instance-id'

/** Prefix of the per-agent host→container tokens; the agent slug follows. */
export const HOST_CONTAINER_TOKEN_KEY_PREFIX = 'host-container-token:'
export function hostContainerTokenKey(agentSlug: string): string {
  return `${HOST_CONTAINER_TOKEN_KEY_PREFIX}${agentSlug}`
}

/** The host-browser providers that keep a persistent Browserbase context per key. */
export type BrowserContextProvider = 'browserbase' | 'platform'
export function browserContextKeyPrefix(provider: BrowserContextProvider): string {
  return `browser-context:${provider}:`
}
export function browserContextKey(provider: BrowserContextProvider, key: string): string {
  return `${browserContextKeyPrefix(provider)}${key}`
}

/** Any non-empty id: installs from before the database kept whatever the file held. */
export const tenantIdRecordSchema = z.string().trim().min(1)

/** Better Auth refuses shorter secrets; the old file loader regenerated them, so they are never imported. */
export const AUTH_SECRET_MIN_LENGTH = 32
export const authSecretRecordSchema = z.string().min(AUTH_SECRET_MIN_LENGTH)

export const hostContainerTokenRecordSchema = z.string().min(1)
export const browserContextIdRecordSchema = z.string().min(1)
export const platformClientInstanceIdRecordSchema = z.string().trim().min(1)

/** The legacy `host-container-tokens.json` and Browserbase context files: one string per key. */
export const legacyStringMapSchema = z.record(z.string(), z.string())
