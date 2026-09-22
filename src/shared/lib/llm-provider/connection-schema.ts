import { z } from 'zod'
import { LLM_PROVIDER_IDS } from './provider-types'
import { catalogOverrideEntrySchema, modelCatalogSchema, modelDefinitionSchema, type ModelDefinition, type CatalogOverrideEntry } from './model-catalog-schema'

export const modelSelectionSchema = z.object({
  llmProviderId: z.string().min(1),
  model: z.string().min(1),
})
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const connectionConfigSchema = z.object({
  apiKeys: z
    .object({
      anthropicApiKey: z.string().optional(),
      openrouterApiKey: z.string().optional(),
      genericApiKey: z.string().optional(),
      genericBaseUrl: z.string().optional(),
      bedrockApiKey: z.string().optional(),
      bedrockAccessKeyId: z.string().optional(),
      bedrockSecretAccessKey: z.string().optional(),
      bedrockRegion: z.string().optional(),
    })
    .default({}),
  // Legacy per-process overrides are moved behind this account boundary.
  // New connections cannot set this through the public mutation API.
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
    config: connectionConfigSchema,
    modelOverrides: connectionModelOverridesSchema.optional(),
    browserModel: z.string().min(1).nullable().optional(),
    dashboardModel: z.string().min(1).nullable().optional(),
  })
  .strict()

/** Public connection representation: never includes secrets or refresh state. */
export const connectionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(LLM_PROVIDER_IDS),
  userId: z.string().nullable(),
  ownerName: z.string().nullable(),
  managed: z.boolean(),
  isConfigured: z.boolean(),
  catalog: modelCatalogSchema,
  modelOverrides: connectionModelOverridesSchema,
  browserModel: z.string().nullable(),
  dashboardModel: z.string().nullable(),
  baseUrl: z.string().optional(),
  region: z.string().optional(),
  canManage: z.boolean(),
  canDelete: z.boolean(),
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
