import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { getSettings, getEffectiveModels, mutateSettings } from '../config/settings'
import { getLlmProvider, resolveModelForProvider } from './index'
import type { LlmProviderId } from './provider-types'
import { connectionCatalogSchema } from './connection-schema'
import { resolveSelection } from './connection-schema'
import { connectionCatalog, getConnection, mutateConnections } from './connections'
import { connectionFromProviderSettings, legacyConnectionId } from './provider-settings'

export interface ProviderSettingsSync {
  providers: LlmProviderId[]
  credentials?: boolean
  catalog?: boolean
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
      const existing = await getConnection(legacyConnectionId(id))
      if (!getLlmProvider(id).getApiKeyStatus().isConfigured && !(sync.credentials && existing)) continue
      const values = connectionFromProviderSettings(id)
      if (!existing) {
        await db.insert(llmConnections).values(values).onConflictDoNothing().run()
        continue
      }
      let syncedCatalog = sync.catalog ? values.catalog : undefined
      if (!syncedCatalog && id === active && sync.models?.length) {
        const currentCatalog = connectionCatalog(existing)
        const purposes = {
          agentModel: 'agent', summarizerModel: 'summarizer',
          browserModel: 'browser', dashboardBuilderModel: 'dashboard',
        } as const
        const catalog = connectionCatalog(values)
        for (const key of sync.models) {
          if (resolveSelection({ connectionId: existing.id, model: models[key] }, [{ id: existing.id, catalog: currentCatalog }])) continue
          const wire = resolveModelForProvider(models[key], id, purposes[key])
          if (!currentCatalog.some((model) => model.id === wire)) {
            const definition = catalog.find((model) => model.id === wire)
            if (definition) currentCatalog.push(definition)
          }
        }
        syncedCatalog = JSON.stringify(connectionCatalogSchema.parse(currentCatalog))
      }
      await db.update(llmConnections).set({
        ...(sync.credentials ? { config: values.config } : {}),
        ...(syncedCatalog ? { catalog: syncedCatalog } : {}),
        ...(id === active && sync.models?.includes('browserModel') ? { browserModel: values.browserModel } : {}),
        ...(id === active && sync.models?.includes('dashboardBuilderModel') ? { dashboardModel: values.dashboardModel } : {}),
        generation: sql`${llmConnections.generation} + 1`,
        updatedAt: new Date(),
      }).where(eq(llmConnections.id, values.id)).run()
    }
    if (!sync.providers.includes(active)) return
    const configured = await getConnection(legacyConnectionId(active))
    if (!configured) return
    const initialSetup = !settings.llmDefault
    if (initialSetup || sync.selectDefault || (sync.models?.length && settings.llmDefault?.connectionId === configured.id)) {
      const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
        connectionId: configured.id,
        model: resolveSelection({ connectionId: configured.id, model }, [{ id: configured.id, catalog: connectionCatalog(configured) }])
          ?.model ?? resolveModelForProvider(model, active, purpose),
      })
      mutateSettings((s) => {
        if (initialSetup || sync.selectDefault || (sync.models?.includes('agentModel') && settings.llmDefault?.connectionId === configured.id)) {
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
