import { and, eq, isNull, isNotNull } from 'drizzle-orm'
import { llmConnections, scheduledTasks, webhookTriggers, chatIntegrations } from '../schema'
import type { DataMigration } from './index'

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
    const { getSettings, getEffectiveModels, mutateSettings } = await import('../../config/settings')
    const { getLlmProvider, resolveModelForProvider } = await import('../../llm-provider')
    const { connectionFromProviderSettings, legacyLlmProviderId } = await import('../../llm-provider/provider-settings')
    const { resolveSelection } = await import('../../llm-provider/connection-schema')
    const { connectionCatalog } = await import('../../llm-provider/connections')
    const settings = getSettings()
    const active = settings.llmProvider ?? 'anthropic'
    const models = getEffectiveModels()
    const legacyModels = new Set<string>()
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      const rows = await db.select({ model: table.model }).from(table)
        .where(and(isNull(table.llmProviderId), isNotNull(table.model))).all()
      for (const row of rows) if (row.model) legacyModels.add(row.model)
    }
    for (const id of new Set([active, 'platform'] as const)) {
      if (!getLlmProvider(id).getApiKeyStatus().isConfigured) continue
      await db.insert(llmConnections)
        .values(connectionFromProviderSettings(id, legacyModels))
        .onConflictDoNothing().run()
    }
    const imported = await db.select().from(llmConnections)
      .where(eq(llmConnections.id, legacyLlmProviderId(active))).get()
    if (!imported) return // Fresh installs configure their connection in onboarding.
    const catalog = connectionCatalog(imported)
    const selection = (model: string, purpose: 'agent' | 'summarizer') => ({
      llmProviderId: imported.id,
      model: resolveSelection({ llmProviderId: imported.id, model }, [{ id: imported.id, catalog }])
        ?.model ?? resolveModelForProvider(model, active, purpose),
    })
    for (const table of [scheduledTasks, webhookTriggers, chatIntegrations]) {
      for (const model of legacyModels) {
        await db.update(table).set(selection(model, 'agent'))
          .where(and(isNull(table.llmProviderId), eq(table.model, model))).run()
      }
    }
    mutateSettings((s) => {
      s.llmLegacyProviderId ??= imported.id
      s.llmDefault ??= selection(models.agentModel, 'agent')
      // An explicit null already means inherit the app default.
      if (s.llmSummarizer === undefined) s.llmSummarizer = selection(models.summarizerModel, 'summarizer')
    })
  },
}
