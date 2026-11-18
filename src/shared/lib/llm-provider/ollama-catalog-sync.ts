import { and, eq } from 'drizzle-orm'
import { getSettings, type AppSettings } from '../config/settings'
import { changesOf } from '../db/batch'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { announceConnectionChange } from './announce-connection-change'
import { connectionConfigSchema, connectionModelOverridesSchema, parseConnectionJson } from './connection-schema'
import { connectionModelOverrides, mutateConnections } from './connections'
import { mergeInstalledModels } from './ollama-catalog'
import { listInstalledOllamaModels } from './ollama-client'
import { normalizeOllamaBaseUrl } from './ollama-schema'
import type { InstalledModel } from './server-status-schema'

type OllamaRow = typeof llmConnections.$inferSelect

/** A row whose stored address no longer parses is left alone rather than failing the rest. */
function serverOf(config: string): string | undefined {
  try {
    return normalizeOllamaBaseUrl(parseConnectionJson(connectionConfigSchema, config).apiKeys.ollamaBaseUrl)
  } catch {
    return undefined
  }
}

/**
 * Write one connection's catalog from what its server reported. Only a server
 * that answered gets here, so an unreachable one never empties a catalog. The
 * row's generation stays: the runtime's endpoint and credentials did not change,
 * so a running session has no reason to restart.
 */
async function applyInstalledModels(row: OllamaRow, installed: readonly InstalledModel[], settings: AppSettings): Promise<void> {
  // A model something is set to use stays listed after an `ollama rm`, so the
  // choice survives a re-pull and a run's own error names the missing model.
  const keep = new Set([
    ...[settings.llmDefault, settings.llmSummarizer].filter(selection => selection?.llmProviderId === row.id).map(selection => selection!.model),
    row.browserModel,
    row.dashboardModel,
  ].filter((model): model is string => !!model))
  const overrides = connectionModelOverrides(row)
  const next = mergeInstalledModels(overrides, installed, { remove: true, keep })
  if (next === overrides) return
  const written = await db.update(llmConnections)
    .set({ modelOverrides: JSON.stringify(connectionModelOverridesSchema.parse(next)), updatedAt: new Date() })
    .where(and(eq(llmConnections.id, row.id), eq(llmConnections.modelOverrides, row.modelOverrides)))
    .run()
  // Lost to a concurrent save: the next pass works from what that save wrote.
  if (!changesOf(written)) console.warn('[ollama] Catalog changed while syncing; retrying on the next pass')
  // A background pass, so no request will refresh the pickers that list these models.
  else announceConnectionChange(row)
}

/**
 * Every connection on a server in `reports` lists what that server said it has.
 * The rows and the settings are each read once, however many servers and
 * connections there are, and inside the connections queue: a save, or a change
 * of the app default, lands wholly before the pass's writes or wholly after.
 */
async function applyReports(reports: ReadonlyMap<string, readonly InstalledModel[]>): Promise<void> {
  if (!reports.size) return
  await mutateConnections(async () => {
    const rows = await db.select().from(llmConnections).where(eq(llmConnections.provider, 'ollama')).all()
    let settings: AppSettings | undefined
    for (const row of rows) {
      const server = serverOf(row.config)
      const installed = server === undefined ? undefined : reports.get(server)
      if (!installed) continue
      settings ??= await getSettings()
      await applyInstalledModels(row, installed, settings)
    }
  })
}

/** Every connection on `baseUrl` lists what the server just said it has. */
export async function syncCatalogsFromStatus(baseUrl: string, installed: readonly InstalledModel[]): Promise<void> {
  await applyReports(new Map([[baseUrl, installed]]))
}

/**
 * Ask each server once. A server that does not answer changes nothing.
 *
 * Resolves with how many Ollama connections there are, so the caller can stop
 * passing while there are none. A pass is one read of the connections; then, if
 * a server answered, one more read of them and one of the settings, and a write
 * for each catalog that changed.
 */
export async function syncAllOllamaCatalogs(): Promise<number> {
  const connections = await db.select({ config: llmConnections.config })
    .from(llmConnections).where(eq(llmConnections.provider, 'ollama')).all()
  const servers = new Set(connections.map(row => serverOf(row.config)).filter(server => server !== undefined))
  const reports = new Map<string, readonly InstalledModel[]>()
  for (const server of servers) {
    try {
      reports.set(server, (await listInstalledOllamaModels(server)).models)
    } catch {
      // Stopped or unreachable: its catalogs keep what they had.
    }
  }
  await applyReports(reports)
  return connections.length
}
