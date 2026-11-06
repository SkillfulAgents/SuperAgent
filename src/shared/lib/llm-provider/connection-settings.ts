import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { effectiveModelsFrom, getSettings, mutateSettings, type ApiKeySettings, type AppSettings } from '../config/settings'
import { getLlmProvider } from './index'
import type { LlmProviderId } from './provider-types'
import { connectionConfigSchema, parseConnectionJson, connectionModelOverridesSchema, mergeConnectionConfig } from './connection-schema'
import { resolveSelection } from './connection-schema'
import { connectionCatalogFrom, connectionModelOverrides, getConnection, mutateConnections, resolveConnectionSelection } from './connections'
import { connectionFromSettings, legacyLlmProviderId, modelResolverFrom, providerCredentialFields } from './provider-settings'

export interface ProviderSettingsSync {
  providers: LlmProviderId[]
  apiKeys?: ApiKeySettings
  catalog?: boolean
  models?: ('agentModel' | 'summarizerModel' | 'browserModel' | 'dashboardBuilderModel')[]
  selectDefault?: boolean
}

/** Compatibility write for the existing settings/onboarding API. Only the
 * explicitly edited providers/fields are written; no historical data is moved.
 *
 * Reads the settings once, and returns the settings as they stand when it is
 * done (what it wrote, else what it read), so a caller answering with the
 * settings need not read them again.
 */
export async function syncProviderSettings(sync: ProviderSettingsSync): Promise<AppSettings> {
  return mutateConnections(async () => {
    const settings = await getSettings()
    const active = settings.llmProvider ?? 'anthropic'
    const models = effectiveModelsFrom(settings)
    for (const id of sync.providers) {
      const existing = await getConnection(legacyLlmProviderId(id))
      const editedKeys = providerCredentialFields[id].filter(key => Object.hasOwn(sync.apiKeys ?? {}, key))
      if (!getLlmProvider(id).apiKeyStatusFrom(settings).isConfigured && !(editedKeys.length > 0 && existing)) continue
      const values = connectionFromSettings(id, settings, models)
      if (!existing) {
        await db.insert(llmConnections).values(values).onConflictDoNothing().run()
        continue
      }
      let syncedOverrides = sync.catalog ? values.modelOverrides : undefined
      if (!syncedOverrides && id === active && sync.models?.length) {
        // The provider's effective catalog is built once, not once per model.
        const resolveModel = modelResolverFrom(id, settings)
        const currentCatalog = connectionCatalogFrom(existing, settings)
        const overrides = connectionModelOverrides(existing)
        const builtins = getLlmProvider(id).getBuiltinCatalog()
        const purposes = {
          agentModel: 'agent', summarizerModel: 'summarizer',
          browserModel: 'browser', dashboardBuilderModel: 'dashboard',
        } as const
        const catalog = connectionCatalogFrom(values, settings)
        for (const key of sync.models) {
          if (resolveSelection({ llmProviderId: existing.id, model: models[key] }, [{ id: existing.id, catalog: currentCatalog }])) continue
          const wire = resolveModel(models[key], purposes[key])
          if (!currentCatalog.some((model) => model.id === wire)) {
            const definition = catalog.find((model) => model.id === wire)
            if (definition) {
              const disabled = overrides.findIndex(model => model.id === wire)
              if (disabled >= 0) overrides.splice(disabled, 1)
              if (!builtins.some(model => model.id === wire)) overrides.push(definition)
              currentCatalog.push(definition)
            }
          }
        }
        syncedOverrides = JSON.stringify(connectionModelOverridesSchema.parse(overrides))
      }
      const updates: Partial<typeof llmConnections.$inferInsert> = {}
      if (editedKeys.length > 0) {
        updates.config = JSON.stringify(mergeConnectionConfig(
          parseConnectionJson(connectionConfigSchema, existing.config),
          { apiKeys: Object.fromEntries(editedKeys.map(key => [key, sync.apiKeys?.[key]])), env: {} },
        ))
      }
      if (syncedOverrides !== undefined) updates.modelOverrides = syncedOverrides
      if (id === active && sync.models?.includes('browserModel')) updates.browserModel = values.browserModel
      if (id === active && sync.models?.includes('dashboardBuilderModel')) updates.dashboardModel = values.dashboardModel
      // Effort/speed edits and identical settings saves do not invalidate every
      // session's query or discard the agent's warm process.
      const changed = Object.entries(updates).some(([key, value]) => value !== existing[key as keyof typeof existing])
      if (changed) {
        await db.update(llmConnections).set({
          ...updates,
          generation: sql`${llmConnections.generation} + 1`,
          updatedAt: new Date(),
        }).where(eq(llmConnections.id, values.id)).run()
      }
    }
    if (!sync.providers.includes(active)) return settings
    const configured = await getConnection(legacyLlmProviderId(active))
    // Agent-only defaults are selected through Model Providers, where a separate
    // summarizer can be chosen. The legacy settings path only selects API defaults.
    if (!configured || !getLlmProvider(active).supportsDirectApi) return settings
    // Read before the awaits above, so only a hint: the write decides again on
    // the settings it replaces.
    if (!settings.llmDefault || sync.selectDefault || (sync.models?.length && settings.llmDefault?.llmProviderId === configured.id)) {
      const catalog = connectionCatalogFrom(configured, settings)
      const resolveModel = modelResolverFrom(active, settings)
      const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
        llmProviderId: configured.id,
        model: resolveSelection({ llmProviderId: configured.id, model }, [{ id: configured.id, catalog }])
          ?.model ?? resolveModel(model, purpose),
      })
      const agentSelection = selection(models.agentModel, 'agent')
      const summarizerSelection = selection(models.summarizerModel, 'summarizer')
      return mutateSettings((s) => {
        // Decided on the settings this write replaces, not the ones read
        // above: a default another writer chose or moved since stands.
        const initialSetup = !s.llmDefault
        if (initialSetup || sync.selectDefault || (sync.models?.includes('agentModel') && s.llmDefault?.llmProviderId === configured.id)) {
          s.llmDefault = { ...agentSelection }
        }
        if (initialSetup || sync.selectDefault || sync.models?.includes('summarizerModel')) {
          s.llmSummarizer = { ...summarizerSelection }
        }
      })
    }
    return settings
  })
}

/** Called on Platform login and startup. Provision from current code defaults,
 * independently of legacy data migrations; preserve existing connection edits.
 * Hosted deployments select Platform in their seed settings and skip onboarding,
 * so this path also initializes their app/helper defaults when absent.
 */
export async function ensureManagedPlatformConnection(): Promise<void> {
  await mutateConnections(async () => {
    const provider = getLlmProvider('platform')
    const settings = await getSettings()
    if (!provider.apiKeyStatusFrom(settings).isConfigured) return
    const llmProviderId = legacyLlmProviderId('platform')
    await db.insert(llmConnections).values({
      id: llmProviderId,
      provider: provider.id,
      name: provider.name,
      userId: null,
      managed: true,
      config: JSON.stringify(connectionConfigSchema.parse({})),
      modelOverrides: JSON.stringify(connectionModelOverridesSchema.parse([])),
      browserModel: provider.getDefaultModel('browser'),
      dashboardModel: provider.getDefaultModel('dashboard'),
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing().run()

    if (settings.llmProvider !== 'platform' || settings.llmDefault) return
    const selected = await resolveConnectionSelection({ llmProviderId }, false, undefined, settings)
    if (!selected) return
    const summarizer = resolveSelection(
      { llmProviderId, model: provider.getDefaultModel('summarizer') },
      [{ id: llmProviderId, catalog: connectionCatalogFrom(selected.connection, settings) }],
    )
    await mutateSettings((s) => {
      // Decided again on the settings this write replaces: a default chosen
      // since the read above stands.
      if (s.llmProvider !== 'platform' || s.llmDefault) return false
      s.llmDefault = { llmProviderId, model: selected.model }
      if (s.llmSummarizer === undefined) {
        s.llmSummarizer = summarizer ? { llmProviderId, model: summarizer.model } : null
      }
    })
  })
}
