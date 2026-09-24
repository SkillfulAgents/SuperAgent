import { isProviderEnvVar } from './provider-env'
import { getSettings, getEffectiveModels, type ApiKeySettings } from '../config/settings'
import { getLlmProvider, resolveModelForProvider } from './index'
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
  openrouter: ['openrouterApiKey'],
  generic: ['genericApiKey', 'genericBaseUrl'],
  bedrock: ['bedrockApiKey', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockRegion'],
  platform: [],
}
const envNames: Record<LlmProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
  'claude-subscription': [],
  'grok-subscription': [],
  'codex-subscription': [],
  openrouter: ['OPENROUTER_API_KEY'],
  generic: ['GENERIC_API_KEY', 'GENERIC_BASE_URL'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'],
  platform: [],
}

/** Build the account used by the existing provider settings/onboarding API.
 * No database access: also usable while openDatabase is running migrations.
 */
export function connectionFromProviderSettings(id: LlmProviderId, extraModels: Iterable<string> = []) {
  const settings = getSettings()
  const active = settings.llmProvider ?? 'anthropic'
  const models = getEffectiveModels()
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
      const wire = resolveModelForProvider(selection, id, purpose)
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
      ?.model ?? resolveModelForProvider(model, id, purpose)
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
        : provider.getDefaultModel('browser'),
    dashboardModel:
      id === active
        ? preserve(models.dashboardBuilderModel, 'dashboard')
        : provider.getDefaultModel('dashboard'),
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  return values
}
