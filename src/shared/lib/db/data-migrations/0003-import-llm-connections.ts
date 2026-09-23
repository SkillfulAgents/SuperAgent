import { isProviderEnvVar } from '../../llm-provider/provider-env'
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
    const { connectionCatalog, globalHelperState } = await import('../../llm-provider/connections')
    const { assertHelperState, assertHelperTransition } = await import('../../llm-provider/helper-policy')
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
      const hasLegacyOverrides = id === active && Object.keys(settings.customEnvVars ?? {}).some(key => isProviderEnvVar(key, id))
      if (!getLlmProvider(id).getApiKeyStatus().isConfigured && !hasLegacyOverrides) continue
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
    const defaults = {
      llmDefault: settings.llmDefault ?? selection(models.agentModel, 'agent'),
      llmSummarizer: settings.llmSummarizer === undefined ? selection(models.summarizerModel, 'summarizer') : settings.llmSummarizer,
    }
    const lookup = async (id: string) => await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get() ?? null
    const after = await globalHelperState({ ...settings, ...defaults }, lookup)
    if (settings.llmDefault) assertHelperTransition(await globalHelperState(settings, lookup), after)
    else assertHelperState(after)
    mutateSettings((s) => {
      // These values are now editable on the imported connection. Keep shared
      // tool variables (including general AWS credentials) in global settings.
      if (s.customEnvVars) s.customEnvVars = Object.fromEntries(
        Object.entries(s.customEnvVars).filter(([key]) => !isProviderEnvVar(key)),
      )
      s.llmLegacyProviderId ??= imported.id
      s.llmDefault = defaults.llmDefault
      // An explicit null already means inherit the app default.
      s.llmSummarizer = defaults.llmSummarizer
    })
  },
}
