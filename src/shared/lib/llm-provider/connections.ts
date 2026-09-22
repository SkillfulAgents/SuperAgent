import { withGlobalModelPricing } from './global-pricing'
import { connectionModelOverridesSchema, normalizeConnectionModelOverrides } from './connection-schema'
import { mergeCatalog } from './catalog-merge'
import { parseConnectionJson } from './connection-schema'
import { randomUUID } from 'node:crypto'
import { legacyLlmProviderId, providerCredentialFields } from './provider-settings'
import { changesOf } from '../db/batch'
import { sql, eq, isNull, or } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import {
  llmConnections,
  user,
} from '../db/schema'
import { getSettings, mutateSettings } from '../config/settings'
import { isAuthMode } from '../auth/mode'
import {
  createLlmProvider,
  getLlmProvider,
  resolveModelForProvider,
} from './index'
import { LLM_PROVIDER_IDS } from './provider-types'
import { type ModelDefinition } from './model-catalog-schema'
import {
  connectionConfigSchema,
  connectionInputSchema,
  modelSelectionSchema,
  resolveSelection,
  type ConnectionInfo,
} from './connection-schema'

export type ConnectionRow = typeof llmConnections.$inferSelect
export type ConnectionViewer = { userId: string | null; admin: boolean }
const providerSchema = z.enum(LLM_PROVIDER_IDS)

export function providerForConnection(
  row: Pick<ConnectionRow, 'provider' | 'config'>
) {
  const config = parseConnectionJson(connectionConfigSchema, row.config)
  const apiKeys = { ...config.apiKeys }
  return createLlmProvider(providerSchema.parse(row.provider), {
    apiKeys,
    env: Object.fromEntries(
      Object.entries(config.env).map(([key, name]) => [key, process.env[name]])
    ),
    runtimeEnv: config.runtimeEnv,
  })
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  return (await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get()) ?? null
}

export function connectionModelOverrides(row: Pick<ConnectionRow, 'provider' | 'modelOverrides'>) {
  return normalizeConnectionModelOverrides(
    getLlmProvider(providerSchema.parse(row.provider)).getBuiltinCatalog(),
    parseConnectionJson(connectionModelOverridesSchema, row.modelOverrides),
  )
}

export function connectionCatalog(row: Pick<ConnectionRow, 'provider' | 'modelOverrides'>): ModelDefinition[] {
  const builtins = getLlmProvider(providerSchema.parse(row.provider)).getBuiltinCatalog()
  return withGlobalModelPricing(mergeCatalog(builtins, connectionModelOverrides(row)), getSettings().modelPricing)
}

// Settings writes are already serialized in the owning app. Keep registry
// writes and mutations in the same queue, including async DB drivers.
let mutations: Promise<unknown> = Promise.resolve()
export function mutateConnections<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(work)
  mutations = result.catch(() => undefined)
  return result
}

export async function listConnections(
  viewer: ConnectionViewer,
  currentId?: string
): Promise<ConnectionInfo[]> {
  const rows = await db
    .select({ connection: llmConnections, ownerName: user.name })
    .from(llmConnections)
    .leftJoin(user, eq(llmConnections.userId, user.id))
    .where(
      or(
        isNull(llmConnections.userId),
        ...(viewer.userId ? [eq(llmConnections.userId, viewer.userId)] : []),
        ...(currentId ? [eq(llmConnections.id, currentId)] : [])
      )
    )
    .all()
  const defaultSelection = await resolveGlobalSelection()
  return rows.map(({ connection: row, ownerName }) => {
    const provider = providerForConnection(row)
    const config = parseConnectionJson(connectionConfigSchema, row.config)
    const canManage = row.userId === null ? viewer.admin : row.userId === viewer.userId
    return {
      id: row.id,
      name: row.name,
      provider: provider.id,
      userId: row.userId,
      ownerName,
      managed: row.managed,
      isConfigured: provider.getApiKeyStatus().isConfigured,
      catalog: connectionCatalog(row),
      modelOverrides: connectionModelOverrides(row),
      browserModel: row.browserModel,
      dashboardModel: row.dashboardModel,
      baseUrl: config.apiKeys.genericBaseUrl,
      region: config.apiKeys.bedrockRegion,
      canManage,
      canDelete:
        canManage &&
        defaultSelection?.llmProviderId !== row.id &&
        !(row.managed && provider.getApiKeyStatus().isConfigured),
    }
  })
}

export function canSelectConnection(
  row: ConnectionRow,
  viewer: ConnectionViewer,
  currentId?: string
): boolean {
  return row.userId === null || row.userId === viewer.userId || row.id === currentId
}

export function assertManageConnection(row: ConnectionRow, viewer: ConnectionViewer): void {
  if (!(row.userId === null ? viewer.admin : row.userId === viewer.userId))
    throw new Error('Connection not found')
}

export async function prepareConnection(raw: unknown, viewer: ConnectionViewer, id?: string) {
  const input = connectionInputSchema.parse(raw)
  const previous = id ? await getConnection(id) : null
  if (id && !previous) throw new Error('Connection not found')
  if (previous) assertManageConnection(previous, viewer)
  if (input.provider === 'platform' && !previous?.managed)
    throw new Error('Manage Platform through the existing Platform login')
  if (input.userId !== null && (!isAuthMode() || input.userId !== viewer.userId))
    throw new Error('Invalid connection owner')
  if (input.userId === null && !viewer.admin)
    throw new Error('Only administrators can manage global connections')
  if (previous && (previous.provider !== input.provider || previous.userId !== input.userId))
    throw new Error('Connection type and owner cannot change')
  const oldConfig = previous ? parseConnectionJson(connectionConfigSchema, previous.config) : null
  const config = connectionConfigSchema.parse({
    ...input.config,
    apiKeys: { ...oldConfig?.apiKeys, ...input.config.apiKeys },
    runtimeEnv: oldConfig?.runtimeEnv ?? {},
    env: oldConfig?.env ?? {}, // Environment bindings come only from migration.
  })
  // Explicit edits replace migrated environment-backed values as well as
  // saved keys. An old custom bearer must not mask a newly entered key.
  const editedKeys = Object.keys(input.config.apiKeys)
  const keyEnvironment: Record<string, string[]> = {
    anthropicApiKey: ['ANTHROPIC_API_KEY'],
    openrouterApiKey: ['OPENROUTER_API_KEY'],
    genericApiKey: ['GENERIC_API_KEY'],
    genericBaseUrl: ['GENERIC_BASE_URL'],
    bedrockApiKey: ['AWS_BEARER_TOKEN_BEDROCK'],
    bedrockAccessKeyId: ['AWS_ACCESS_KEY_ID'],
    bedrockSecretAccessKey: ['AWS_SECRET_ACCESS_KEY'],
    bedrockRegion: ['AWS_REGION'],
  }
  for (const key of editedKeys) {
    for (const name of keyEnvironment[key] ?? []) delete config.env[name]
  }
  if (editedKeys.some((key) => key !== 'genericBaseUrl' && key !== 'bedrockRegion')) {
    for (const key of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      delete config.runtimeEnv[key]
    }
  }
  if (editedKeys.includes('genericBaseUrl')) delete config.runtimeEnv.ANTHROPIC_BASE_URL
  if (editedKeys.includes('bedrockRegion')) delete config.runtimeEnv.AWS_REGION
  const builtins = getLlmProvider(input.provider).getBuiltinCatalog()
  const modelOverrides = normalizeConnectionModelOverrides(
    builtins,
    input.modelOverrides ?? (previous ? connectionModelOverrides(previous) : []),
  )
  const catalog = mergeCatalog(builtins, modelOverrides)
  return { input, previous, config, catalog, modelOverrides }
}

export async function saveConnection(
  raw: unknown,
  viewer: ConnectionViewer,
  id?: string
): Promise<string> {
  return mutateConnections(async () => {
    const { input, previous, config, catalog, modelOverrides } = await prepareConnection(raw, viewer, id)
    const llmProviderId = id ?? randomUUID()
    const root = await resolveGlobalSelection()
    if (
      root?.llmProviderId === llmProviderId &&
      !resolveSelection(root, [{ id: llmProviderId, catalog }])
    ) {
      throw new Error('Change the app default before removing its model')
    }
    const values = {
      name: input.name,
      provider: input.provider,
      userId: input.userId,
      config: JSON.stringify(config),
      modelOverrides: JSON.stringify(connectionModelOverridesSchema.parse(modelOverrides)),
      browserModel: input.browserModel ?? null,
      dashboardModel: input.dashboardModel ?? null,
      updatedAt: new Date(),
    }
    if (previous) {
      const updated = await db
        .update(llmConnections)
        .set({
          ...values,
          generation: sql`${llmConnections.generation} + 1`,
        })
        .where(eq(llmConnections.id, llmProviderId))
        .run()
      if (!changesOf(updated)) throw new Error('Connection no longer exists')
    } else {
      await db
        .insert(llmConnections)
        .values({ ...values, id: llmProviderId, createdAt: new Date() })
        .run()
    }
    return llmProviderId
  })
}

export async function deleteConnection(id: string, viewer: ConnectionViewer): Promise<void> {
  await mutateConnections(async () => {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection not found')
    assertManageConnection(row, viewer)
    if ((await resolveGlobalSelection())?.llmProviderId === id)
      throw new Error('Change the app default before deleting this connection')
    if (row.managed && providerForConnection(row).getApiKeyStatus().isConfigured)
      throw new Error('Platform cannot be deleted while connected')
    await db.delete(llmConnections).where(eq(llmConnections.id, id)).run()
    if (id === legacyLlmProviderId(providerSchema.parse(row.provider))) {
      const config = parseConnectionJson(connectionConfigSchema, row.config)
      mutateSettings((settings) => {
        for (const key of providerCredentialFields[providerSchema.parse(row.provider)]) delete settings.apiKeys?.[key]
        for (const [key, value] of Object.entries(config.runtimeEnv)) {
          if (settings.customEnvVars?.[key] === value) delete settings.customEnvVars[key]
        }
      })
    }
  })
}

export async function setGlobalSelection(
  purpose: 'default' | 'summarizer',
  raw: unknown
): Promise<void> {
  const selection =
    raw === null && purpose === 'summarizer' ? null : modelSelectionSchema.parse(raw)
  await mutateConnections(async () => {
    const resolved = await resolveConnectionSelection(selection)
    if (selection && (!resolved || resolved.connection.userId !== null))
      throw new Error('Select a model from a global connection')
    mutateSettings((s) => {
      if (purpose === 'default' && selection) s.llmDefault = selection
      else s.llmSummarizer = selection
    })
  })
}

type StoredModelSelection = { llmProviderId: string; model?: string }

function defaultSelectionForConnection(row: ConnectionRow) {
  const catalog = connectionCatalog(row)
  const provider = providerForConnection(row)
  const preferred = resolveSelection(
    { llmProviderId: row.id, model: provider.getDefaultModel('agent') },
    [{ id: row.id, catalog }],
  )
  const fallback = catalog.find(model => model.isDefault) ?? catalog[0]
  const selected = preferred ?? (fallback ? { llmProviderId: row.id, model: fallback.id, wireModel: fallback.id } : null)
  return selected ? { ...selected, connection: row, provider } : null
}

export async function resolveConnectionSelection(
  selection: StoredModelSelection | null | undefined,
  allowLegacyPin = false,
) {
  if (!selection) return null
  const row = await getConnection(selection.llmProviderId)
  if (!row) return null
  if (!selection.model) return defaultSelectionForConnection(row)
  const provider = providerForConnection(row)
  const resolved = resolveSelection({ ...selection, model: selection.model }, [{ id: row.id, catalog: connectionCatalog(row) }])
  if (resolved) return { ...resolved, connection: row, provider }
  // Pre-upgrade files and model-only clients could use an arbitrary wire ID.
  // Preserve that request locally; resolving it must never edit a global catalog.
  if (legacySelections.has(selection) || (allowLegacyPin && row.id === getSettings().llmLegacyProviderId)) {
    return { ...selection, model: selection.model,
      wireModel: resolveModelForProvider(selection.model, provider.id, 'agent'),
      connection: row, provider }
  }
  return null
}
export type ResolvedConnection = NonNullable<Awaited<ReturnType<typeof resolveConnectionSelection>>>

const legacySelections = new WeakSet<StoredModelSelection>()

/** Undefined ID is legacy data. Explicit NULL is a cleared/deleted binding. */
export function storedSelection(
  model?: string | null,
  llmProviderId?: string | null
): StoredModelSelection | null {
  if (llmProviderId === null || (!model && !llmProviderId)) return null
  const id = llmProviderId ?? getSettings().llmLegacyProviderId
  if (!id) return null
  const selection = { llmProviderId: id, ...(model ? { model } : {}) }
  if (llmProviderId === undefined) legacySelections.add(selection)
  return selection
}

/** Resolve the app default without mutating settings during a read. A retired
 * model falls back within its provider; a lost row falls back to the migrated
 * active global provider, never to a personal account or an ambient API key.
 */
export async function resolveGlobalSelection(): Promise<ResolvedConnection | null> {
  const settings = getSettings()
  const root = settings.llmDefault
  const selected = await resolveConnectionSelection(root)
  if (selected?.connection.userId === null) return selected
  const ids = new Set([root?.llmProviderId, settings.llmLegacyProviderId, legacyLlmProviderId(settings.llmProvider ?? 'anthropic')])
  for (const id of ids) {
    if (!id) continue
    const row = await getConnection(id)
    if (row?.userId !== null) continue
    const fallback = defaultSelectionForConnection(row)
    if (fallback) return fallback
  }
  return null
}

export async function resolveSelectionHierarchy(
  ...candidates: (StoredModelSelection | null | undefined)[]
): Promise<ResolvedConnection> {
  for (const candidate of candidates) {
    const resolved = await resolveConnectionSelection(candidate, true)
    if (resolved) return resolved
  }
  const root = await resolveGlobalSelection()
  if (!root) throw new Error('Configure a global default connection and model in Settings → LLM')
  return root
}

export const resolveExecutionSelection = resolveSelectionHierarchy

export async function resolveHelperSelection(): Promise<ResolvedConnection> {
  const override = await resolveConnectionSelection(getSettings().llmSummarizer)
  if (override?.connection.userId === null) return override
  return resolveSelectionHierarchy()
}
