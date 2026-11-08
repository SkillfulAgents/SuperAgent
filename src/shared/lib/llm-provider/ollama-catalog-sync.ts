import { and, eq } from 'drizzle-orm'
import { getSettings } from '../config/settings'
import { changesOf } from '../db/batch'
import { db } from '../db'
import { llmConnections } from '../db/schema'
import { connectionConfigSchema, connectionModelOverridesSchema, parseConnectionJson } from './connection-schema'
import { connectionModelOverrides, getConnection, mutateConnections } from './connections'
import { mergeInstalledModels } from './ollama-catalog'
import { listInstalledOllamaModels } from './ollama-client'
import { normalizeOllamaBaseUrl, type OllamaInstalledModel } from './ollama-schema'

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
async function applyInstalledModels(id: string, installed: readonly OllamaInstalledModel[]): Promise<void> {
  await mutateConnections(async () => {
    const row = await getConnection(id)
    if (row?.provider !== 'ollama') return
    const settings = await getSettings()
    // A model something is set to use stays listed after an `ollama rm`, so the
    // choice survives a re-pull and a run's own error names the missing model.
    const keep = new Set([
      ...[settings.llmDefault, settings.llmSummarizer].filter(selection => selection?.llmProviderId === id).map(selection => selection!.model),
      row.browserModel,
      row.dashboardModel,
    ].filter((model): model is string => !!model))
    const overrides = connectionModelOverrides(row)
    const next = mergeInstalledModels(overrides, installed, { remove: true, keep })
    if (next === overrides) return
    const written = await db.update(llmConnections)
      .set({ modelOverrides: JSON.stringify(connectionModelOverridesSchema.parse(next)), updatedAt: new Date() })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.modelOverrides, row.modelOverrides)))
      .run()
    // Lost to a concurrent save: the next pass works from what that save wrote.
    if (!changesOf(written)) console.warn('[ollama] Catalog changed while syncing; retrying on the next pass')
  })
}

async function ollamaConnections() {
  const rows = await db.select({ id: llmConnections.id, config: llmConnections.config })
    .from(llmConnections).where(eq(llmConnections.provider, 'ollama')).all()
  return rows.map(row => ({ id: row.id, server: serverOf(row.config) }))
}

/** Every connection on `baseUrl` lists what the server just said it has. */
export async function syncCatalogsFromStatus(baseUrl: string, installed: readonly OllamaInstalledModel[]): Promise<void> {
  for (const row of await ollamaConnections()) {
    if (row.server === baseUrl) await applyInstalledModels(row.id, installed)
  }
}

/** Ask a server what it has, and update every connection on it. Throws when it cannot be asked. */
export async function syncCatalogsForServer(baseUrl: string): Promise<void> {
  await syncCatalogsFromStatus(baseUrl, (await listInstalledOllamaModels(baseUrl)).models)
}

/** Ask each server once. A server that does not answer changes nothing. */
export async function syncAllOllamaCatalogs(): Promise<void> {
  const servers = new Set((await ollamaConnections()).map(row => row.server).filter(server => server !== undefined))
  for (const server of servers) {
    await syncCatalogsForServer(server).catch(() => {
      // Stopped or unreachable: its catalogs keep what they had.
    })
  }
}
