import { oauthCredentialSchema } from './oauth-schema'
import { isReservedEnvVar } from '../container/reserved-env-vars'
import { z } from 'zod'
import { LLM_PROVIDER_IDS } from './provider-types'
import { catalogOverrideEntrySchema, modelCatalogSchema, modelDefinitionSchema, type ModelDefinition, type CatalogOverrideEntry } from './model-catalog-schema'

export const modelSelectionSchema = z.object({
  llmProviderId: z.string().min(1),
  model: z.string().min(1),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const apiFormatSchema = z.enum(['messages', 'chat-completions', 'responses'])

export const connectionConfigSchema = z.object({
  apiFormat: apiFormatSchema.optional(),
  chatTokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  oauth: oauthCredentialSchema.optional(),
  apiKeys: z
    .object({
      anthropicApiKey: z.string().optional(),
      claudeSubscriptionToken: z.string().trim().optional(),
      openrouterApiKey: z.string().optional(),
      genericApiKey: z.string().optional(),
      genericBaseUrl: z.string().optional(),
      bedrockApiKey: z.string().optional(),
      bedrockAccessKeyId: z.string().optional(),
      bedrockSecretAccessKey: z.string().optional(),
      bedrockRegion: z.string().optional(),
    })
    .default({}),
  // Custom variables belong to this account and are sent only with its runtime.
  runtimeEnv: z.record(z.string(), z.string()).default({}),
  // Names only: resolve environment-backed values at execution time. Extra
  // connections never inherit the host's ambient provider credentials.
  env: z.record(z.string(), z.string()).default({}),
})
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>

/** Persist custom definitions and explicit disabled IDs, never built-in definitions or prices. */
export const connectionModelOverridesSchema = z.array(catalogOverrideEntrySchema.omit({ pricing: true }))
const customModelSchema = modelDefinitionSchema.omit({ pricing: true })

export function normalizeConnectionModelOverrides(
  builtins: readonly ModelDefinition[],
  overrides: readonly CatalogOverrideEntry[],
): CatalogOverrideEntry[] {
  const builtinIds = new Set(builtins.map(model => model.id))
  return overrides.flatMap((entry): CatalogOverrideEntry[] => {
    // A disabled built-in may disappear in a later release. Its saved ID remains harmless.
    if (builtinIds.has(entry.id) || (entry.disabled && !entry.label)) {
      return entry.disabled ? [{ id: entry.id, disabled: true }] : []
    }
    return [{ ...customModelSchema.parse(entry), ...(entry.disabled ? { disabled: true } : {}) }]
  })
}

export const connectionInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    provider: z.enum(LLM_PROVIDER_IDS),
    userId: z.string().min(1).nullable().default(null),
    oauthLoginId: z.string().optional(),
    config: connectionConfigSchema.omit({ oauth: true }).extend({
      // Omitted values are unchanged; null explicitly removes a saved value.
      runtimeEnv: z.record(
        z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid environment variable name'),
        z.string().nullable(),
      ).superRefine((vars, ctx) => {
        const reserved = Object.keys(vars).filter(isReservedEnvVar)
        if (reserved.length) ctx.addIssue({ code: 'custom', message: `Cannot override reserved runtime variables: ${reserved.join(', ')}` })
      }).optional(),
    }),
    modelOverrides: connectionModelOverridesSchema.optional(),
    browserModel: z.string().min(1).nullable().optional(),
    dashboardModel: z.string().min(1).nullable().optional(),
  })
  .strict()

/** Apply credential edits before explicit env edits so a newly supplied key
 * clears stale migrated auth, while an intentional env override can replace it. */
export function mergeConnectionConfig(
  previous: ConnectionConfig | null,
  input: z.infer<typeof connectionInputSchema>['config'],
): ConnectionConfig {
  const config = connectionConfigSchema.parse({
    oauth: previous?.oauth ? { ...previous.oauth, refreshLease: undefined } : undefined,
    apiFormat: input.apiFormat ?? previous?.apiFormat,
    chatTokenLimitField: input.chatTokenLimitField ?? previous?.chatTokenLimitField,
    apiKeys: { ...previous?.apiKeys, ...input.apiKeys },
    runtimeEnv: previous?.runtimeEnv ?? {},
    env: previous?.env ?? {}, // Host bindings come only from migration.
  })
  const keyEnvironment: Record<string, string[]> = {
    anthropicApiKey: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    claudeSubscriptionToken: ['CLAUDE_CODE_OAUTH_TOKEN'],
    openrouterApiKey: ['OPENROUTER_API_KEY'],
    genericApiKey: ['GENERIC_API_KEY'],
    genericBaseUrl: ['GENERIC_BASE_URL'],
    bedrockApiKey: ['AWS_BEARER_TOKEN_BEDROCK'],
    bedrockAccessKeyId: ['AWS_ACCESS_KEY_ID'],
    bedrockSecretAccessKey: ['AWS_SECRET_ACCESS_KEY'],
    bedrockRegion: ['AWS_REGION'],
  }
  const editedKeys = Object.keys(input.apiKeys)
  for (const key of editedKeys) {
    for (const name of keyEnvironment[key] ?? []) delete config.env[name]
  }
  if (editedKeys.some(key => key !== 'genericBaseUrl' && key !== 'bedrockRegion')) {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      delete config.runtimeEnv[key]
    }
  }
  if (editedKeys.includes('genericBaseUrl')) delete config.runtimeEnv.ANTHROPIC_BASE_URL
  if (editedKeys.includes('bedrockRegion')) delete config.runtimeEnv.AWS_REGION
  for (const [key, value] of Object.entries(input.runtimeEnv ?? {})) {
    delete config.env[key]
    if (value === null) delete config.runtimeEnv[key]
    else config.runtimeEnv[key] = value
  }
  return config
}

/** Public connection representation: never includes secrets or refresh state. */
export const connectionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(LLM_PROVIDER_IDS),
  userId: z.string().nullable(),
  ownerName: z.string().nullable(),
  accountLabel: z.string().optional(),
  managed: z.boolean(),
  isConfigured: z.boolean(),
  supportsDirectApi: z.boolean().optional(),
  supportsUsage: z.boolean().optional(),
  catalog: modelCatalogSchema,
  modelOverrides: connectionModelOverridesSchema,
  defaultModel: z.string().nullable(),
  browserModel: z.string().nullable(),
  dashboardModel: z.string().nullable(),
  baseUrl: z.string().optional(),
  apiFormat: apiFormatSchema.optional(),
  chatTokenLimitField: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  region: z.string().optional(),
  customEnvVarKeys: z.array(z.string()).optional(),
  canManage: z.boolean(),
  canDelete: z.boolean(),
  deletionBlockedReason: z.string().optional(),
})
export type ConnectionInfo = z.infer<typeof connectionInfoSchema>

/** Shared by the renderer and execution surfaces. Catalogs are local data;
 * network/auth errors never mean that a model was deleted. */
export function resolveSelection(
  selection: ModelSelection | null | undefined,
  connections: readonly Pick<ConnectionInfo, 'id' | 'catalog'>[]
): (ModelSelection & { wireModel: string }) | null {
  if (!selection) return null
  const connection = connections.find((c) => c.id === selection.llmProviderId)
  const model =
    connection?.catalog.find((m) => m.id === selection.model) ??
    connection?.catalog.find((m) => m.family === selection.model && m.isLatest)
  return model ? { ...selection, wireModel: model.id } : null
}

/** Validate saved JSON without surfacing configuration or credential values. */
export function parseConnectionJson<T>(schema: z.ZodType<T>, raw: string): T {
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    throw new Error('Invalid saved LLM connection data')
  }
}
