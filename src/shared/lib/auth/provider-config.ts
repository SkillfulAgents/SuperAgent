import { captureException } from '@shared/lib/error-reporting'
import { z } from 'zod'

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
  discoveryUrl?: string
  issuer?: string
  clientId: string
  clientSecret?: string
  scopes?: string[]
  pkce: true
  accessType: 'offline'
  requireIssuerValidation: true
  overrideUserInfo: true
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
    const discoveryUrl = this.config.discoveryUrl?.trim() || undefined
    const issuer = this.config.issuer?.trim() || undefined
    const clientId = this.config.clientId?.trim()
    if ((!discoveryUrl && !issuer) || !clientId) return null

    return {
      providerId: this.config.id,
      discoveryUrl,
      issuer,
      clientId,
      clientSecret: this.config.clientSecret?.trim() || undefined,
      scopes: this.config.scopes,
      pkce: true,
      accessType: 'offline',
      requireIssuerValidation: true,
      overrideUserInfo: true,
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
