import { captureException } from '@shared/lib/error-reporting'
import { decodeOrgIdFromToken } from '@shared/lib/platform-auth/decode-org-id'
import { PLATFORM_CLAIMS } from '@shared/lib/platform-auth/claims'
import { notePlatformRole } from './platform-role'
import { z } from 'zod'
import { getAppBaseUrl } from './config'

// Shape of each entry in the AUTH_PROVIDERS_JSON env bundle. Provider
// secrets belong in deployment env, not user-writable settings.json — so
// this lives next to the resolver instead of in shared settings types.
export type AuthProviderType = 'oidc'

const AuthProviderSettingsSchema = z.object({
  id: z.string().min(1),
  type: z.literal('oidc'),
  enabled: z.boolean().optional(),
  displayName: z.string().optional(),
  discoveryUrl: z.string().optional(),
  issuer: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  scopes: z.array(z.string()).optional(),
  icon: z.string().optional(),
})

export type AuthProviderSettings = z.infer<typeof AuthProviderSettingsSchema>

export interface PublicAuthProviderReadiness {
  ok: boolean
  reasons: string[]
}

// Public shape: no secrets, safe to ship to clients.
export interface PublicAuthProviderConfig {
  id: string
  type: AuthProviderType
  displayName: string
  icon: string | null
  enabled: boolean
  available: boolean
  readiness: PublicAuthProviderReadiness
}

// Shape consumed by Better Auth's genericOAuth plugin. Kept separate from
// `AuthProviderSettings` so callers can't accidentally pipe raw settings
// (which carry `clientSecret`) into public surfaces.
export interface GenericOAuthProviderConfig {
  providerId: string
  discoveryUrl: string
  redirectURI: string
  clientId: string
  clientSecret?: string
  scopes?: string[]
  pkce: true
  accessType: 'offline'
  requireIdTokenVerification: true
  disableProviderLogout: true
  overrideUserInfo: true
  accountSubject: (context: { profile: Record<string, unknown> }) => string
  mapProfileToUser?: (profile: Record<string, unknown>) => Record<string, never>
}

abstract class AuthProviderDefinition {
  constructor(protected readonly config: AuthProviderSettings) {}

  get id(): string {
    return this.config.id
  }

  toPublicConfig(): PublicAuthProviderConfig {
    const readiness = this.getReadiness()
    return {
      id: this.config.id,
      type: this.config.type,
      displayName: this.getDisplayName(),
      icon: this.config.icon ?? null,
      enabled: this.config.enabled !== false,
      available: readiness.ok,
      readiness,
    }
  }

  protected getDisplayName(): string {
    return this.config.displayName?.trim() || this.config.id
  }

  protected abstract getReadiness(): PublicAuthProviderReadiness
  abstract toGenericOAuthConfig(): GenericOAuthProviderConfig | null
}

class OidcAuthProviderDefinition extends AuthProviderDefinition {
  protected getReadiness(): PublicAuthProviderReadiness {
    const reasons: string[] = []

    if (!this.config.discoveryUrl?.trim() && !this.config.issuer?.trim()) {
      reasons.push('Missing discovery URL or issuer')
    }
    if (!this.config.clientId?.trim()) {
      reasons.push('Missing client ID')
    }

    return {
      ok: reasons.length === 0,
      reasons,
    }
  }

  toGenericOAuthConfig(): GenericOAuthProviderConfig | null {
    const issuer = this.config.issuer?.trim() || undefined
    const discoveryUrl = this.config.discoveryUrl?.trim()
      || (issuer ? `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration` : undefined)
    const clientId = this.config.clientId?.trim()
    if (!discoveryUrl || !clientId) return null

    return {
      providerId: this.config.id,
      discoveryUrl,
      // This callback is already registered by the deployment controller and
      // self-hosted IdPs. The route adapter dispatches it to Better Auth 1.7's
      // core callback without changing the redirect URI sent to the provider.
      redirectURI: `${getAppBaseUrl().replace(/\/+$/, '')}/api/auth/oauth2/callback/${encodeURIComponent(this.config.id)}`,
      clientId,
      clientSecret: this.config.clientSecret?.trim() || undefined,
      scopes: this.config.scopes,
      pkce: true,
      accessType: 'offline',
      requireIdTokenVerification: true,
      // Preserve deployment-only logout: signing out here must not also sign
      // the user out of the platform or another app sharing the same IdP.
      disableProviderLogout: true,
      overrideUserInfo: true,
      accountSubject: ({ profile }) => {
        // Every configured provider is OIDC. Never fall back to a mutable
        // profile id if discovery omits its signing-algorithm advertisement.
        if (typeof profile.sub !== 'string' || !profile.sub) {
          throw new Error('OIDC profile is missing its subject')
        }
        return profile.sub
      },
      mapProfileToUser: (profile: Record<string, unknown>) => {
        // Platform-only: require verified email before first-time link/provision.
        if (this.config.id === 'platform' && profile.email_verified !== true) {
          throw new Error('Platform email is not verified')
        }
        // org-pinned deployment: id_token org_id must match; throw aborts
        // before Better Auth creates the user/account/session.
        const deploymentOrg = decodeOrgIdFromToken(process.env.PLATFORM_TOKEN ?? '')
        if (deploymentOrg) {
          const tokenOrg = profile[PLATFORM_CLAIMS.orgId]
          if (typeof tokenOrg !== 'string' || tokenOrg !== deploymentOrg) {
            throw new Error('Account belongs to a different organization')
          }
        }
        // Held for the user create hook, should this sign-in create the user.
        if (this.config.id === 'platform') notePlatformRole(profile[PLATFORM_CLAIMS.role])
        // Never override id: account.accountId must stay the OIDC sub.
        return {}
      },
    }
  }
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

let cachedAuthProvidersRaw: string | undefined
let cachedAuthProviders: AuthProviderSettings[] | null = null

function cacheResolvedAuthProviders(raw: string | undefined, providers: AuthProviderSettings[]): AuthProviderSettings[] {
  cachedAuthProvidersRaw = raw
  cachedAuthProviders = providers
  return providers
}

function reportProviderConfigError(error: unknown, op: string, extra?: Record<string, unknown>): void {
  captureException(error, {
    tags: { area: 'auth', op },
    ...(extra ? { extra } : {}),
  })
}

// TODO: Keep OIDC providers deployment-managed for now. If we ever expose
// admin-managed provider config, prefer deployment-time tooling over storing
// provider secrets in app settings.
function resolveEnvAuthProviders(): AuthProviderSettings[] {
  const raw = readEnv('AUTH_PROVIDERS_JSON')
  if (cachedAuthProvidersRaw === raw && cachedAuthProviders) {
    return cachedAuthProviders
  }
  if (!raw) return cacheResolvedAuthProviders(raw, [])

  try {
    const parsed = JSON.parse(raw) as unknown
    const result = z.array(AuthProviderSettingsSchema).safeParse(parsed)
    if (!result.success) {
      reportProviderConfigError(result.error, 'schema-env-providers')
      return cacheResolvedAuthProviders(raw, [])
    }
    return cacheResolvedAuthProviders(raw, result.data)
  } catch (error) {
    reportProviderConfigError(error, 'parse-env-providers')
    return cacheResolvedAuthProviders(raw, [])
  }
}

function createProviderDefinition(config: AuthProviderSettings): AuthProviderDefinition {
  switch (config.type) {
    case 'oidc':
      return new OidcAuthProviderDefinition(config)
  }
}

function getEnabledProviderDefinitions(
  providers: AuthProviderSettings[] = resolveEnvAuthProviders(),
): AuthProviderDefinition[] {
  return providers
    .filter((provider) => provider.enabled !== false)
    .map(createProviderDefinition)
}

export function getGenericOAuthProviderConfigs(): GenericOAuthProviderConfig[] {
  return getEnabledProviderDefinitions()
    .map((definition) => definition.toGenericOAuthConfig())
    .filter((config): config is GenericOAuthProviderConfig => config !== null)
}

export function getPublicAuthProviders(
  providers: AuthProviderSettings[] = resolveEnvAuthProviders(),
): PublicAuthProviderConfig[] {
  return getEnabledProviderDefinitions(providers).map((definition) => definition.toPublicConfig())
}

// Whether the named provider is present and not explicitly disabled. Used to
// gate flows (e.g. token exchange) that must not run when platform login has
// been turned off, matching the interactive-login surface.
export function isAuthProviderEnabled(id: string): boolean {
  return resolveEnvAuthProviders().some((p) => p.id === id && p.enabled !== false)
}

// An explicit operator pin must not be replaced with discovery's issuer. Unlike
// getAuthProviderIssuer, this deliberately has no discovery-URL fallback.
export function getExplicitAuthProviderIssuer(id: string): string | undefined {
  return resolveEnvAuthProviders()
    .find((provider) => provider.id === id && provider.enabled !== false)?.issuer?.trim() || undefined
}

// Issuer for the named provider, derived from `issuer` or `discoveryUrl`.
export function getAuthProviderIssuer(id: string): string | undefined {
  const providers = resolveEnvAuthProviders()
  const found = providers.find((p) => p.id === id)
  if (!found) return undefined
  const issuer = found.issuer?.trim()
  if (issuer) return issuer
  const discovery = found.discoveryUrl?.trim()
  if (!discovery) return undefined
  try {
    return new URL(discovery).origin
  } catch {
    return undefined
  }
}
