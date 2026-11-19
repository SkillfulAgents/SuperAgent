import { isProviderEnvVar } from '../../llm-provider/provider-env'
import { and, eq, isNull, isNotNull } from 'drizzle-orm'
import { llmConnections, scheduledTasks, webhookTriggers, chatIntegrations } from '../schema'
import type { DataMigration } from './index'
import { importLegacyRecords } from './0009-import-host-records'

/** Import the former global provider settings once, before the database opens.
 * Stable IDs, insert-if-absent and nullable-reference updates tolerate a crash
 * before the runner records this migration in its ledger.
 */
export const importLlmConnections: DataMigration = {
  id: 3,
  name: 'import-llm-connections',
  async run(db) {
    // Keep provider/service imports out of the database bootstrap module graph.
    // The migration uses its injected handle; the global db is not open yet.
    const { getSettings, mutateSettings } = await import('../../config/settings')
    const { getLlmProvider, resolveModelForProviderFrom } = await import('../../llm-provider')
    const { connectionFromSettings, effectiveModelsFrom, legacyLlmProviderId } = await import('../../llm-provider/provider-settings')
    const { resolveSelection } = await import('../../llm-provider/connection-schema')
    const { connectionCatalogFrom } = await import('../../llm-provider/connections')
    // The settings on this migration's handle, legacy settings.json imported
    // first; nothing below reads the global database, which is not open yet.
    await importLegacyRecords(db)
    const settings = await getSettings(db)
    const active = settings.llmProvider ?? 'anthropic'
    const models = effectiveModelsFrom(settings)
    const legacyModels = new Set<string>()
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      const rows = await db.select({ model: table.model }).from(table)
        .where(and(isNull(table.llmProviderId), isNotNull(table.model))).all()
      for (const row of rows) if (row.model) legacyModels.add(row.model)
    }
    for (const id of new Set([active, 'platform'] as const)) {
      const hasLegacyOverrides = id === active && Object.keys(settings.customEnvVars ?? {}).some(key => isProviderEnvVar(key, id))
      if (!getLlmProvider(id).apiKeyStatusFrom(settings).isConfigured && !hasLegacyOverrides) continue
      await db.insert(llmConnections)
        .values(connectionFromSettings(id, settings, models, legacyModels))
        .onConflictDoNothing().run()
    }
    const imported = await db.select().from(llmConnections)
      .where(eq(llmConnections.id, legacyLlmProviderId(active))).get()
    if (!imported) return // Fresh installs configure their connection in onboarding.
    const catalog = connectionCatalogFrom(imported, settings)
    const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
      llmProviderId: imported.id,
      model: resolveSelection({ llmProviderId: imported.id, model }, [{ id: imported.id, catalog }])
        ?.model ?? resolveModelForProviderFrom(model, active, purpose, settings),
    })
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      for (const model of legacyModels) {
        await db.update(table).set(selection(model, 'agent'))
          .where(and(isNull(table.llmProviderId), eq(table.model, model))).run()
      }
    }
    const defaultSelection = selection(models.agentModel, 'agent')
    const summarizerSelection = selection(models.summarizerModel, 'summarizer')
    // Only changes the draft: the mutator may run again on a write conflict.
    await mutateSettings((s) => {
      // These values are now editable on the imported connection. Keep shared
      // tool variables (including general AWS credentials) in global settings.
      if (s.customEnvVars) s.customEnvVars = Object.fromEntries(
        Object.entries(s.customEnvVars).filter(([key]) => !isProviderEnvVar(key)),
      )
      s.llmLegacyProviderId ??= imported.id
      s.llmDefault ??= { ...defaultSelection }
      // An explicit null already means inherit the app default.
      if (s.llmSummarizer === undefined) s.llmSummarizer = { ...summarizerSelection }
    }, db)
  },
}
