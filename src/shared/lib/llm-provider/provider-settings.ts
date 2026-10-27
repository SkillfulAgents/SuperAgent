import { isProviderEnvVar } from './provider-env'
import {
  effectiveModelsFrom,
  getSettings,
  type ApiKeySettings,
  type AppSettings,
  type ModelSettings,
} from '../config/settings'
import { effectiveCatalogFrom, getLlmProvider, resolveModelInCatalog } from './index'
import type { ModelPurpose } from './base-llm-provider'
import type { ModelDefinition } from './model-catalog-schema'
import type { LlmProviderId } from './provider-types'
import { connectionModelOverridesSchema, normalizeConnectionModelOverrides } from './connection-schema'
import { mergeCatalog } from './catalog-merge'
import { connectionConfigSchema, resolveSelection } from './connection-schema'

export const legacyLlmProviderId = (provider: LlmProviderId) => `legacy-${provider}`
export const providerCredentialFields: Record<LlmProviderId, (keyof ApiKeySettings)[]> = {
  anthropic: ['anthropicApiKey'],
  'claude-subscription': [],
  'grok-subscription': [],
  'codex-subscription': [],
  'kimi-subscription': [],
  'minimax-subscription': [],
  'qwen-subscription': [],
  'doubao-subscription': [],
  openrouter: ['openrouterApiKey'],
  ollama: [],
  generic: ['genericApiKey', 'genericBaseUrl'],
  bedrock: ['bedrockApiKey', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockRegion'],
  platform: [],
}
const envNames: Record<LlmProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  'claude-subscription': [],
  'grok-subscription': [],
  'codex-subscription': [],
  'kimi-subscription': [],
  'minimax-subscription': [],
  'qwen-subscription': [],
  'doubao-subscription': [],
  openrouter: ['OPENROUTER_API_KEY'],
  ollama: [],
  generic: ['GENERIC_API_KEY', 'GENERIC_BASE_URL'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'],
  platform: [],
}

export { effectiveModelsFrom } from '../config/settings'

/** Build the account used by the existing provider settings/onboarding API, from one settings read. */
export async function connectionFromProviderSettings(id: LlmProviderId, extraModels: Iterable<string> = []) {
  const settings = await getSettings()
  return connectionFromSettings(id, settings, effectiveModelsFrom(settings), extraModels)
}

/**
 * Resolves selections for `id` against its effective catalog, built from
 * `settings` on first use and then reused: a loop over the model settings
 * builds the catalog once, not once per model.
 */
export function modelResolverFrom(id: LlmProviderId, settings: AppSettings) {
  let effective: ModelDefinition[] | undefined
  return (selection: string, purpose: ModelPurpose) =>
    resolveModelInCatalog(selection, id, purpose, effective ??= effectiveCatalogFrom(id, settings), settings.modelCatalog)
}

/**
 * {@link connectionFromProviderSettings} from the settings and effective
 * models already read. No database access and no settings read: also usable
 * while openDatabase is running migrations, on the migration's own handle.
 */
export function connectionFromSettings(
  id: LlmProviderId,
  settings: AppSettings,
  models: ModelSettings,
  extraModels: Iterable<string> = [],
) {
  const active = settings.llmProvider ?? 'anthropic'
  const provider = getLlmProvider(id)
  const config = connectionConfigSchema.parse({
    apiKeys: Object.fromEntries(
      providerCredentialFields[id]
        .filter((key) => settings.apiKeys?.[key] !== undefined)
        .map((key) => [key, settings.apiKeys?.[key]])
    ),
    env: Object.fromEntries(envNames[id].map((name) => [name, name])),
    runtimeEnv:
      id === active
        ? Object.fromEntries(
            Object.entries(settings.customEnvVars ?? {}).filter(([key]) =>
              isProviderEnvVar(key, id)
            )
          )
        : {},
  })
  const builtins = provider.getBuiltinCatalog()
  const legacyOverrides = settings.modelCatalog?.[id]?.overrides ?? []
  // Materialize only custom entries (including disabled ones); built-ins keep their code definitions.
  const customModels = mergeCatalog([], legacyOverrides
    .filter(entry => !builtins.some(builtin => builtin.id === entry.id))
    .map(({ disabled: _disabled, ...entry }) => entry))
  const modelOverrides = normalizeConnectionModelOverrides(builtins, [
    ...customModels.map(model => ({ ...model, ...(legacyOverrides.findLast(entry => entry.id === model.id)?.disabled ? { disabled: true } : {}) })),
    ...legacyOverrides.filter(entry => builtins.some(builtin => builtin.id === entry.id)),
  ])
  const catalog = mergeCatalog(builtins, modelOverrides)
  const resolveModel = modelResolverFrom(id, settings)
  // Old version pins could be sent even if absent from the built-in
  // catalog. Preserve explicit app defaults as catalog entries on import.
  if (id === active) {
    for (const [selection, purpose] of [
      [models.agentModel, 'agent'],
      [models.summarizerModel, 'summarizer'],
      [models.browserModel, 'browser'],
      [models.dashboardBuilderModel, 'dashboard'],
      ...[...extraModels].map((model) => [model, 'agent']),
    ] as [string, 'agent' | 'summarizer' | 'browser' | 'dashboard'][]) {
      const wire = resolveModel(selection, purpose)
      if (!catalog.some((m) => m.id === wire)) {
        const definition = builtins.find(model => model.id === wire)
          ?? { id: wire, label: wire, supportedEfforts: ['low' as const, 'medium' as const, 'high' as const] }
        // An explicit legacy selection re-enables its model without storing a built-in copy.
        const disabled = modelOverrides.findIndex(model => model.id === wire)
        if (disabled >= 0) modelOverrides.splice(disabled, 1)
        if (!builtins.some(model => model.id === wire)) modelOverrides.push(definition)
        catalog.push(definition)
      }
    }
  }
  const preserve = (model: string, purpose: 'agent' | 'summarizer' | 'browser' | 'dashboard') =>
    resolveSelection({ llmProviderId: legacyLlmProviderId(id), model }, [{ id: legacyLlmProviderId(id), catalog }])
      ?.model ?? resolveModel(model, purpose)
  const values = {
    id: legacyLlmProviderId(id),
    provider: id,
    name: provider.name,
    userId: null,
    managed: id === 'platform',
    config: JSON.stringify(config),
    modelOverrides: JSON.stringify(connectionModelOverridesSchema.parse(modelOverrides)),
    browserModel:
      id === active
        ? preserve(models.browserModel, 'browser')
        : provider.getDefaultModel('browser', settings.modelCatalog),
    dashboardModel:
      id === active
        ? preserve(models.dashboardBuilderModel, 'dashboard')
        : provider.getDefaultModel('dashboard', settings.modelCatalog),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return values
}
