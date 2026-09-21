import { getSettings, getEffectiveModels } from '../config/settings'
import { getLlmProvider, getEffectiveCatalog, resolveModelForProvider } from './index'
import type { LlmProviderId } from './provider-types'
import { connectionCatalogSchema } from './connection-schema'
import { connectionConfigSchema, resolveSelection, type ConnectionConfig } from './connection-schema'

export const legacyConnectionId = (provider: LlmProviderId) => `legacy-${provider}`
export const providerCredentialFields: Record<LlmProviderId, (keyof ConnectionConfig['apiKeys'])[]> = {
  anthropic: ['anthropicApiKey'],
  openrouter: ['openrouterApiKey'],
  generic: ['genericApiKey', 'genericBaseUrl'],
  bedrock: ['bedrockApiKey', 'bedrockAccessKeyId', 'bedrockSecretAccessKey', 'bedrockRegion'],
  platform: [],
}
const envNames: Record<LlmProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  generic: ['GENERIC_API_KEY', 'GENERIC_BASE_URL'],
  bedrock: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'],
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
              /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_USE_(BEDROCK|VERTEX)$|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|BEARER_TOKEN_BEDROCK|REGION)$)/.test(
                key
              )
            )
          )
        : {},
  })
  const catalog = getEffectiveCatalog(id)
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
      if (!catalog.some((m) => m.id === wire))
        catalog.push({ id: wire, label: wire, supportedEfforts: ['low', 'medium', 'high'] })
    }
  }
  const preserve = (model: string, purpose: 'agent' | 'summarizer' | 'browser' | 'dashboard') =>
    resolveSelection({ connectionId: legacyConnectionId(id), model }, [{ id: legacyConnectionId(id), catalog }])
      ?.model ?? resolveModelForProvider(model, id, purpose)
  const values = {
    id: legacyConnectionId(id),
    provider: id,
    name: provider.name,
    userId: null,
    managed: id === 'platform',
    config: JSON.stringify(config),
    catalog: JSON.stringify(connectionCatalogSchema.parse(catalog)),
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
