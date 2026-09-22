import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { getSettings, getEffectiveModels, mutateSettings } from '../config/settings'
import { getLlmProvider, resolveModelForProvider } from './index'
import type { LlmProviderId } from './provider-types'
import { connectionConfigSchema, parseConnectionJson, connectionModelOverridesSchema } from './connection-schema'
import { resolveSelection } from './connection-schema'
import { connectionCatalog, connectionModelOverrides, getConnection, mutateConnections } from './connections'
import { connectionFromProviderSettings, legacyLlmProviderId } from './provider-settings'

export interface ProviderSettingsSync {
  providers: LlmProviderId[]
  credentials?: boolean
  catalog?: boolean
  runtimeEnv?: boolean
  models?: ('agentModel' | 'summarizerModel' | 'browserModel' | 'dashboardBuilderModel')[]
  selectDefault?: boolean
}

/** Compatibility write for the existing settings/onboarding API. Only the
 * explicitly edited providers/fields are written; no historical data is moved.
 */
export async function syncProviderSettings(sync: ProviderSettingsSync): Promise<void> {
  return mutateConnections(async () => {
    const settings = getSettings()
    const active = settings.llmProvider ?? 'anthropic'
    const models = getEffectiveModels()
    for (const id of sync.providers) {
      const existing = await getConnection(legacyLlmProviderId(id))
      if (!getLlmProvider(id).getApiKeyStatus().isConfigured && !(sync.credentials && existing)) continue
      const values = connectionFromProviderSettings(id)
      if (!existing) {
        await db.insert(llmConnections).values(values).onConflictDoNothing().run()
        continue
      }
      let syncedOverrides = sync.catalog ? values.modelOverrides : undefined
      if (!syncedOverrides && id === active && sync.models?.length) {
        const currentCatalog = connectionCatalog(existing)
        const overrides = connectionModelOverrides(existing)
        const builtins = getLlmProvider(id).getBuiltinCatalog()
        const purposes = {
          agentModel: 'agent', summarizerModel: 'summarizer',
          browserModel: 'browser', dashboardBuilderModel: 'dashboard',
        } as const
        const catalog = connectionCatalog(values)
        for (const key of sync.models) {
          if (resolveSelection({ llmProviderId: existing.id, model: models[key] }, [{ id: existing.id, catalog: currentCatalog }])) continue
          const wire = resolveModelForProvider(models[key], id, purposes[key])
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
      if (sync.credentials) updates.config = values.config
      else if (sync.runtimeEnv && id === active) {
        const config = parseConnectionJson(connectionConfigSchema, existing.config)
        config.runtimeEnv = parseConnectionJson(connectionConfigSchema, values.config).runtimeEnv
        updates.config = JSON.stringify(config)
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
    if (!sync.providers.includes(active)) return
    const configured = await getConnection(legacyLlmProviderId(active))
    if (!configured) return
    const initialSetup = !settings.llmDefault
    if (initialSetup || sync.selectDefault || (sync.models?.length && settings.llmDefault?.llmProviderId === configured.id)) {
      const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
        llmProviderId: configured.id,
        model: resolveSelection({ llmProviderId: configured.id, model }, [{ id: configured.id, catalog: connectionCatalog(configured) }])
          ?.model ?? resolveModelForProvider(model, active, purpose),
      })
      mutateSettings((s) => {
        if (initialSetup || sync.selectDefault || (sync.models?.includes('agentModel') && settings.llmDefault?.llmProviderId === configured.id)) {
          s.llmDefault = selection(models.agentModel, 'agent')
        }
        if (initialSetup || sync.selectDefault || sync.models?.includes('summarizerModel')) {
          s.llmSummarizer = selection(models.summarizerModel, 'summarizer')
        }
      })
    }
  })
}

/** Called on Platform login and environment initialization, never on reads.
 * Insert only: reconnecting preserves the managed connection's catalog/defaults.
 */
export async function ensureManagedPlatformConnection(): Promise<void> {
  await mutateConnections(async () => {
    if (!getLlmProvider('platform').getApiKeyStatus().isConfigured) return
    await db.insert(llmConnections).values(connectionFromProviderSettings('platform'))
      .onConflictDoNothing().run()
  })
}
