import { batch, type BatchStatement } from '../db/batch'
import { assertHelperState } from './helper-policy'
import { eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { getSettings, getEffectiveModels, mutateSettings, type ApiKeySettings, type AppSettings } from '../config/settings'
import { getLlmProvider, resolveModelForProvider } from './index'
import type { LlmProviderId } from './provider-types'
import { connectionConfigSchema, parseConnectionJson, connectionModelOverridesSchema, mergeConnectionConfig } from './connection-schema'
import { resolveSelection } from './connection-schema'
import { connectionCatalog, connectionModelOverrides, getConnection, mutateConnections, resolveConnectionSelection, globalHelperState, assertConnectionHelperEdits, providerForConnection, type ConnectionRow } from './connections'
import { connectionFromProviderSettings, legacyLlmProviderId, providerCredentialFields } from './provider-settings'

export interface ProviderSettingsSync {
  providers: LlmProviderId[]
  apiKeys?: ApiKeySettings
  catalog?: boolean
  models?: ('agentModel' | 'summarizerModel' | 'browserModel' | 'dashboardBuilderModel')[]
  selectDefault?: boolean
}

/** Compatibility write for the existing settings/onboarding API. Only the
 * explicitly edited providers/fields are written; no historical data is moved.
 */
export async function syncProviderSettings(sync: ProviderSettingsSync, settingsPatch?: {
  read: () => AppSettings
  save: (defaults: Pick<AppSettings, 'llmDefault' | 'llmSummarizer'>) => void
}): Promise<void> {
  return mutateConnections(async () => {
    const settings = settingsPatch?.read() ?? getSettings()
    const proposed = new Map<string, ConnectionRow>()
    const writes: BatchStatement[] = []
    const active = settings.llmProvider ?? 'anthropic'
    const models = getEffectiveModels(settings)
    for (const id of sync.providers) {
      const existing = await getConnection(legacyLlmProviderId(id))
      const editedKeys = providerCredentialFields[id].filter(key => Object.hasOwn(sync.apiKeys ?? {}, key))
      const values = connectionFromProviderSettings(id, [], settings)
      if (!providerForConnection(values).getApiKeyStatus().isConfigured && !(editedKeys.length > 0 && existing)) continue
      if (!existing) {
        proposed.set(values.id, { ...values, generation: 0 })
        writes.push(db.insert(llmConnections).values(values).onConflictDoNothing())
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
        proposed.set(values.id, { ...existing, ...updates })
        writes.push(db.update(llmConnections).set({
          ...updates,
          generation: sql`${llmConnections.generation} + 1`,
          updatedAt: new Date(),
        }).where(eq(llmConnections.id, values.id)))
      }
    }
    const next = { ...settings }
    const configured = proposed.get(legacyLlmProviderId(active)) ?? await getConnection(legacyLlmProviderId(active))
    const initialSetup = !settings.llmDefault
    if (sync.providers.includes(active) && configured && (initialSetup || sync.selectDefault || (sync.models?.length && settings.llmDefault?.llmProviderId === configured.id))) {
      const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
        llmProviderId: configured.id,
        model: resolveSelection({ llmProviderId: configured.id, model }, [{ id: configured.id, catalog: connectionCatalog(configured) }])
          ?.model ?? resolveModelForProvider(model, active, purpose),
      })
      if (initialSetup || sync.selectDefault || (sync.models?.includes('agentModel') && settings.llmDefault?.llmProviderId === configured.id)) {
        next.llmDefault = selection(models.agentModel, 'agent')
      }
      if (initialSetup || sync.selectDefault || sync.models?.includes('summarizerModel')) {
        next.llmSummarizer = selection(models.summarizerModel, 'summarizer')
      }
    }
    await assertConnectionHelperEdits(proposed, next)
    await batch(writes)
    const defaults = { llmDefault: next.llmDefault, llmSummarizer: next.llmSummarizer }
    if (settingsPatch) settingsPatch.save(defaults)
    else mutateSettings(s => { Object.assign(s, defaults) })
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
    if (!provider.getApiKeyStatus().isConfigured) return
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

    const settings = getSettings()
    if (settings.llmProvider !== 'platform' || settings.llmDefault) return
    const selected = await resolveConnectionSelection({ llmProviderId })
    if (!selected) return
    const summarizer = resolveSelection(
      { llmProviderId, model: provider.getDefaultModel('summarizer') },
      [{ id: llmProviderId, catalog: connectionCatalog(selected.connection) }],
    )
    const defaults = {
      llmDefault: { llmProviderId, model: selected.model },
      llmSummarizer: settings.llmSummarizer === undefined ? summarizer ? { llmProviderId, model: summarizer.model } : null : settings.llmSummarizer,
    }
    assertHelperState(await globalHelperState({ ...settings, ...defaults }))
    mutateSettings((s) => {
      s.llmDefault = { llmProviderId, model: selected.model }
      if (s.llmSummarizer === undefined) {
        s.llmSummarizer = summarizer ? { llmProviderId, model: summarizer.model } : null
      }
    })
  })
}
