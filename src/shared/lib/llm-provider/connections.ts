import { credentialsFromLogin, consumeOAuthLogin } from './oauth-login'
import { resolveConnectionCredential, waitForConnectionRefresh } from './connection-credentials'
import { HelperConfigurationError } from './helper-error'
import { withGlobalModelPricing } from './global-pricing'
import { findAdminOnlyProviderEnvVars, isProviderEnvVar } from './provider-env'
import { connectionModelOverridesSchema, normalizeConnectionModelOverrides } from './connection-schema'
import { mergeCatalog } from './catalog-merge'
import { bestAllowedModel } from './model-availability'
import { parseConnectionJson } from './connection-schema'
import { randomUUID } from 'node:crypto'
import { legacyLlmProviderId, providerCredentialFields } from './provider-settings'
import { changesOf } from '../db/batch'
import { sql, eq, isNull, or, and } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import {
  llmConnections,
  user,
} from '../db/schema'
import { getSettings, mutateSettings, type AppSettings } from '../config/settings'
import { isAuthMode } from '../auth/mode'
import {
  createLlmProvider,
  getLlmProvider,
  resolveModelForProviderFrom,
} from './index'
import { LLM_PROVIDER_IDS, isOAuthProvider } from './provider-types'
import { type ModelDefinition } from './model-catalog-schema'
import {
  connectionConfigSchema,
  connectionInputSchema,
  mergeConnectionConfig,
  modelSelectionSchema,
  globalSelectionStateSchema,
  resolveSelection,
  type ConnectionInfo,
  type ModelSelection,
  type GlobalSelectionState,
  type GlobalSelectionChange,
} from './connection-schema'

export type ConnectionRow = typeof llmConnections.$inferSelect
export type ConnectionViewer = { userId: string | null; admin: boolean }
const providerSchema = z.enum(LLM_PROVIDER_IDS)

export function providerForConnection(
  row: Pick<ConnectionRow, 'provider' | 'config'> & Partial<Pick<ConnectionRow, 'id'>>
) {
  const config = parseConnectionJson(connectionConfigSchema, row.config)
  const apiKeys = { ...config.apiKeys }
  return createLlmProvider(providerSchema.parse(row.provider), {
    apiKeys,
    apiFormat: config.apiFormat,
    chatTokenLimitField: config.chatTokenLimitField,
    oauth: config.oauth,
    resolveCredential: row.id ? (generation) => resolveConnectionCredential(row.id!, generation) : undefined,
    env: Object.fromEntries(
      Object.entries(config.env).map(([key, name]) => [key, process.env[name]])
    ),
    runtimeEnv: config.runtimeEnv,
  })
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  return (await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get()) ?? null
}

/** Connection rows a request already read, by id: the resolvers below look there before reading a row. */
export type ReadConnections = ReadonlyMap<string, ConnectionRow>

async function connectionRow(id: string, read?: ReadConnections): Promise<ConnectionRow | null> {
  return read?.get(id) ?? getConnection(id)
}

export function connectionModelOverrides(row: Pick<ConnectionRow, 'provider' | 'modelOverrides'>) {
  return normalizeConnectionModelOverrides(
    getLlmProvider(providerSchema.parse(row.provider)).getBuiltinCatalog(),
    parseConnectionJson(connectionModelOverridesSchema, row.modelOverrides),
  )
}

export async function connectionCatalog(row: Pick<ConnectionRow, 'provider' | 'modelOverrides'>): Promise<ModelDefinition[]> {
  return connectionCatalogFrom(row, await getSettings())
}

/** {@link connectionCatalog} from global settings already read (for their model prices). */
export function connectionCatalogFrom(
  row: Pick<ConnectionRow, 'provider' | 'modelOverrides'>,
  settings: Pick<AppSettings, 'modelPricing'>,
): ModelDefinition[] {
  const builtins = getLlmProvider(providerSchema.parse(row.provider)).getBuiltinCatalog()
  return withGlobalModelPricing(mergeCatalog(builtins, connectionModelOverrides(row)), settings.modelPricing)
}

// Settings writes are already serialized in the owning app. Keep registry
// writes and mutations in the same queue, including async DB drivers.
let mutations: Promise<unknown> = Promise.resolve()
export function mutateConnections<T>(work: () => Promise<T>): Promise<T> {
  const result = mutations.then(work)
  mutations = result.catch(() => undefined)
  return result
}

type VisibleConnectionRow = { connection: ConnectionRow; ownerName: string | null }

async function readVisibleConnections(viewer: ConnectionViewer, currentId?: string): Promise<VisibleConnectionRow[]> {
  return db
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
}

const readById = (rows: VisibleConnectionRow[]): ReadConnections => new Map(rows.map(({ connection }) => [connection.id, connection]))

export async function listConnections(
  viewer: ConnectionViewer,
  currentId?: string
): Promise<ConnectionInfo[]> {
  const rows = await readVisibleConnections(viewer, currentId)
  const settings = await getSettings()
  return connectionInfos(rows, viewer, await resolveGlobalSelection(readById(rows), settings), settings)
}

/** The connections a viewer sees, with the app default and summarizer, from one read of the connections. */
export async function listConnectionsWithSelection(viewer: ConnectionViewer): Promise<{ connections: ConnectionInfo[] } & GlobalSelectionState> {
  const rows = await readVisibleConnections(viewer)
  const read = readById(rows)
  const settings = await getSettings()
  const [root, summarizer] = await Promise.all([resolveGlobalSelection(read, settings), resolveSummarizerSelection(read, settings)])
  return { connections: await connectionInfos(rows, viewer, root, settings), ...selectionState(root, summarizer) }
}

async function connectionInfos(
  rows: VisibleConnectionRow[],
  viewer: ConnectionViewer,
  defaultSelection: ResolvedConnection | null,
  settings: AppSettings,
): Promise<ConnectionInfo[]> {
  return Promise.all(rows.map(async ({ connection: row, ownerName }) => {
    const provider = providerForConnection(row)
    const config = parseConnectionJson(connectionConfigSchema, row.config)
    const canManage = row.userId === null ? viewer.admin : row.userId === viewer.userId
    const deletionBlockedReason = connectionDeletionReason(row, viewer, defaultSelection, settings)
    return {
      id: row.id,
      name: row.name,
      provider: provider.id,
      userId: row.userId,
      ownerName,
      accountLabel: canManage ? config.oauth?.accountLabel : undefined,
      managed: row.managed,
      isConfigured: provider.apiKeyStatusFrom(settings).isConfigured,
      supportsDirectApi: provider.supportsDirectApi,
      supportsUsage: provider.supportsUsage,
      supportsModelAvailability: provider.supportsModelAvailability,
      modelAvailabilityRevision: await provider.getModelAvailabilityRevision(),
      catalog: connectionCatalogFrom(row, settings),
      defaultModel: defaultSelectionForConnection(row, 'agent', settings)?.model ?? null,
      modelOverrides: connectionModelOverrides(row),
      browserModel: row.browserModel,
      dashboardModel: row.dashboardModel,
      baseUrl: config.apiKeys.genericBaseUrl,
      apiFormat: config.apiFormat,
      chatTokenLimitField: config.chatTokenLimitField,
      region: config.apiKeys.bedrockRegion ?? config.oauth?.region,
      customEnvVarKeys: canManage ? Object.keys(config.runtimeEnv) : [],
      canManage,
      deletionBlockedReason,
      canDelete: deletionBlockedReason === undefined,
    }
  }))
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
  let previous = id ? await getConnection(id) : null
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
  let oldConfig = previous ? parseConnectionJson(connectionConfigSchema, previous.config) : null
  while (!input.oauthLoginId && oldConfig?.oauth?.refreshLease && oldConfig.oauth.refreshLease.expiresAt > Date.now()) {
    await waitForConnectionRefresh(id!)
    previous = await getConnection(id!)
    if (!previous) throw new Error('Connection not found')
    assertManageConnection(previous, viewer)
    oldConfig = parseConnectionJson(connectionConfigSchema, previous.config)
  }
  const config = mergeConnectionConfig(oldConfig, input.config)
  if (input.oauthLoginId) {
    if (!isOAuthProvider(input.provider)) throw new Error('Invalid subscription sign-in')
    config.oauth = credentialsFromLogin(input.oauthLoginId, viewer, input.userId, id, input.provider)
  }
  if (isOAuthProvider(input.provider)) {
    if (!config.oauth) throw new Error('Sign in before saving this subscription connection')
    const conflicting = Object.keys(config.runtimeEnv).filter(key => isProviderEnvVar(key) || key === 'CLAUDE_CONFIG_DIR')
    if (conflicting.length) throw new Error('This subscription manages its own authentication. Remove provider authentication environment variables.')
  }
  if (!viewer.admin) {
    // Check the merged config for saves and validation alike. Omitted saved
    // values cannot bypass the policy; explicit nulls can remove them.
    const restricted = findAdminOnlyProviderEnvVars(config.runtimeEnv)
    if (restricted.length) throw new Error(`Only administrators can set these environment variables: ${restricted.join(', ')}`)
  }
  if (input.provider === 'claude-subscription') {
    if (!/^sk-ant-oat\d+-[A-Za-z0-9_-]+$/.test(config.apiKeys.claudeSubscriptionToken ?? ''))
      throw new Error('Paste the token generated by claude setup-token')
    const conflicting = Object.keys(config.runtimeEnv).filter(key => isProviderEnvVar(key) || key === 'CLAUDE_CONFIG_DIR')
    if (conflicting.length)
      throw new Error(`Claude Subscription manages its own authentication. Remove these environment variables: ${conflicting.join(', ')}`)
  }
  if (input.provider !== 'claude-subscription' && (
    'CLAUDE_CODE_OAUTH_TOKEN' in config.runtimeEnv ||
    'CLAUDE_CODE_OAUTH_TOKEN' in config.env ||
    config.apiKeys.claudeSubscriptionToken
  )) throw new Error('Subscription tokens require a Claude Subscription provider. Remove CLAUDE_CODE_OAUTH_TOKEN and add a Claude Subscription provider instead.')
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
        .where(and(eq(llmConnections.id, llmProviderId), eq(llmConnections.config, previous.config), eq(llmConnections.generation, previous.generation)))
        .run()
      if (!changesOf(updated)) throw new Error('Connection changed while saving. Please retry.')
    } else {
      await db
        .insert(llmConnections)
        .values({ ...values, id: llmProviderId, createdAt: new Date() })
        .run()
    }
    if (input.oauthLoginId) consumeOAuthLogin(input.oauthLoginId)
    return llmProviderId
  })
}

export async function shareConnection(id: string, viewer: ConnectionViewer): Promise<void> {
  await mutateConnections(async () => {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection not found')
    assertManageConnection(row, viewer)
    if (row.userId === null) return
    if (!viewer.admin) throw new Error('Only administrators can share connections with everyone')
    // Ownership does not change credentials. Rotating their generation here
    // would discard a concurrent OAuth refresh's newly issued token pair.
    const updated = await db
      .update(llmConnections)
      .set({ userId: null, updatedAt: new Date() })
      .where(and(eq(llmConnections.id, id), eq(llmConnections.userId, row.userId)))
      .run()
    if (!changesOf(updated)) throw new Error('Connection changed while saving. Please retry.')
  })
}

export async function deleteConnection(id: string, viewer: ConnectionViewer): Promise<void> {
  await mutateConnections(async () => {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection not found')
    assertManageConnection(row, viewer)
    const settings = await getSettings()
    const reason = connectionDeletionReason(row, viewer, await resolveGlobalSelection(undefined, settings), settings)
    if (reason) throw new Error(reason)
    await db.delete(llmConnections).where(eq(llmConnections.id, id)).run()
    const provider = providerSchema.parse(row.provider)
    if (id === legacyLlmProviderId(provider)) {
      const config = parseConnectionJson(connectionConfigSchema, row.config)
      // Only changes the draft: the mutator may run again on a write conflict.
      await mutateSettings((s) => {
        for (const key of providerCredentialFields[provider]) delete s.apiKeys?.[key]
        for (const [key, value] of Object.entries(config.runtimeEnv)) {
          if (s.customEnvVars?.[key] === value) delete s.customEnvVars[key]
        }
      })
    }
  })
}

async function applyGlobalSelection(
  purpose: 'default' | 'summarizer',
  selection: ModelSelection | null,
  restore?: { summarizerSelection: ModelSelection | null },
): Promise<void> {
  const resolved = await resolveConnectionSelection(selection)
  if (selection && (!resolved || resolved.connection.userId !== null))
    throw new Error('Select a model from a global connection')
  if (purpose === 'summarizer' && resolved && !resolved.provider.supportsDirectApi)
    throw new Error('This provider cannot be used as a summarizer. Choose an API-capable provider.')
  let summarizerSelection = purpose === 'summarizer' ? selection : (await getSettings()).llmSummarizer
  // Whether this call decides the summarizer. When it does not, the write
  // leaves it alone: writing back the value read above would revert a
  // summarizer another writer chose in the meantime.
  let decidesSummarizer = purpose === 'summarizer'
  const root = purpose === 'default' ? resolved : await resolveGlobalSelection()
  if (root?.provider.supportsDirectApi === false) {
    const summarizer = purpose === 'summarizer' ? resolved : await resolveSummarizerSelection()
    if (!isHelperSelection(summarizer)) {
      // A subscription default still needs the API-capable helper used by the previous default.
      const inherited = purpose === 'default' ? await resolveGlobalSelection() : null
      if (!isHelperSelection(inherited))
        throw new Error('Choose a separate API-capable summarizer before using this app default.')
      summarizerSelection = { llmProviderId: inherited.llmProviderId, model: inherited.model }
      decidesSummarizer = true
    }
  }
  if (restore) {
    summarizerSelection = restore.summarizerSelection
    decidesSummarizer = true
  }
  await mutateSettings((s) => {
    if (purpose === 'default' && selection) s.llmDefault = selection
    if (decidesSummarizer) s.llmSummarizer = summarizerSelection
  })
}

export async function globalSelectionState(): Promise<GlobalSelectionState> {
  const settings = await getSettings()
  const [root, summarizer] = await Promise.all([resolveGlobalSelection(undefined, settings), resolveSummarizerSelection(undefined, settings)])
  return selectionState(root, summarizer)
}

function selectionState(root: ResolvedConnection | null, summarizer: ResolvedConnection | null): GlobalSelectionState {
  return {
    defaultSelection: root ? { llmProviderId: root.llmProviderId, model: root.model } : null,
    summarizerSelection: isHelperSelection(summarizer) ? { llmProviderId: summarizer.llmProviderId, model: summarizer.model } : null,
  }
}

export async function setGlobalSelection(
  purpose: 'default' | 'summarizer',
  raw: unknown
): Promise<GlobalSelectionChange> {
  const selection = raw === null && purpose === 'summarizer' ? null : modelSelectionSchema.parse(raw)
  return mutateConnections(async () => {
    // Capture the rollback state in the same queue as the write, never from a client's cache.
    const before = await globalSelectionState()
    await applyGlobalSelection(purpose, selection)
    return { before, after: await globalSelectionState() }
  })
}

/** Restore a previous app default and summarizer only if nothing changed them since `expected` was observed. */
export async function compareAndSetGlobalDefault(expectedRaw: unknown, restoreRaw: unknown): Promise<boolean> {
  const expected = globalSelectionStateSchema.parse(expectedRaw)
  const restore = globalSelectionStateSchema.parse(restoreRaw)
  if (!expected.defaultSelection || !restore.defaultSelection)
    throw new Error('Select a model from a global connection')
  return mutateConnections(async () => {
    const current = await globalSelectionState()
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false
    if (restore.summarizerSelection && !isHelperSelection(await resolveConnectionSelection(restore.summarizerSelection)))
      throw new Error('Select an API-capable global summarizer')
    const root = await resolveConnectionSelection(restore.defaultSelection)
    if (root?.provider.supportsDirectApi === false && !restore.summarizerSelection)
      throw new Error('Choose a separate API-capable summarizer before using this app default.')
    await applyGlobalSelection('default', restore.defaultSelection, { summarizerSelection: restore.summarizerSelection })
    return true
  })
}

type StoredModelSelection = { llmProviderId: string; model?: string }

function defaultSelectionForConnection(row: ConnectionRow, purpose: 'agent' | 'summarizer', settings: Pick<AppSettings, 'modelPricing'>) {
  const catalog = connectionCatalogFrom(row, settings)
  const provider = providerForConnection(row)
  const preferred = resolveSelection(
    { llmProviderId: row.id, model: provider.getDefaultModel(purpose) },
    [{ id: row.id, catalog }],
  )
  const fallback = catalog.find(model => model.isDefault) ?? catalog[0]
  const selected = preferred ?? (fallback ? { llmProviderId: row.id, model: fallback.id, wireModel: fallback.id } : null)
  return selected ? { ...selected, connection: row, provider } : null
}

/** `settings`: the global settings when the caller already read them; read here otherwise. */
export async function resolveConnectionSelection(
  selection: StoredModelSelection | null | undefined,
  allowLegacyPin = false,
  read?: ReadConnections,
  settings?: AppSettings,
) {
  if (!selection) return null
  const row = await connectionRow(selection.llmProviderId, read)
  if (!row) return null
  const current = settings ?? await getSettings()
  if (!selection.model) return defaultSelectionForConnection(row, 'agent', current)
  const provider = providerForConnection(row)
  const resolved = resolveSelection({ ...selection, model: selection.model }, [{ id: row.id, catalog: connectionCatalogFrom(row, current) }])
  if (resolved) return { ...resolved, connection: row, provider }
  // Pre-upgrade files and model-only clients could use an arbitrary wire ID.
  // Preserve that request locally; resolving it must never edit a global catalog.
  if (legacySelections.has(selection) || (allowLegacyPin && row.id === current.llmLegacyProviderId)) {
    return { ...selection, model: selection.model,
      wireModel: resolveModelForProviderFrom(selection.model, provider.id, 'agent', current),
      connection: row, provider }
  }
  return null
}
export type ResolvedConnection = NonNullable<Awaited<ReturnType<typeof resolveConnectionSelection>>>

const legacySelections = new WeakSet<StoredModelSelection>()

type SelectionCandidate = StoredModelSelection | null | undefined

/** Undefined ID is legacy data. Explicit NULL is a cleared/deleted binding. */
export async function storedSelection(
  model?: string | null,
  llmProviderId?: string | null,
  settings?: Pick<AppSettings, 'llmLegacyProviderId'>,
): Promise<StoredModelSelection | null> {
  if (llmProviderId === null || (!model && !llmProviderId)) return null
  // Settings are needed only for legacy data, which names no connection; read
  // them then, unless the caller already has them.
  const id = llmProviderId ?? (settings ?? await getSettings()).llmLegacyProviderId
  if (!id) return null
  const selection = { llmProviderId: id, ...(model ? { model } : {}) }
  if (llmProviderId === undefined) legacySelections.add(selection)
  return selection
}

/** Resolve the app default without mutating settings during a read. A retired
 * model falls back within its provider; a lost row falls back to the migrated
 * active global provider, never to a personal account or an ambient API key.
 */
export async function resolveGlobalSelection(read?: ReadConnections, settings?: AppSettings): Promise<ResolvedConnection | null> {
  const current = settings ?? await getSettings()
  const root = current.llmDefault
  const selected = await resolveConnectionSelection(root, false, read, current)
  if (selected?.connection.userId === null) return selected
  const ids = new Set([root?.llmProviderId, current.llmLegacyProviderId, legacyLlmProviderId(current.llmProvider ?? 'anthropic')])
  for (const id of ids) {
    if (!id) continue
    const row = await connectionRow(id, read)
    if (row?.userId !== null) continue
    const fallback = defaultSelectionForConnection(row, 'agent', current)
    if (fallback) return fallback
  }
  return null
}

// Catalog ids the connection's provider says cannot run now (e.g. the acting
// account's plan excludes them). Execution only: settings show saved values.
async function unavailableModelIds(row: ConnectionRow, settings: AppSettings): Promise<Set<string>> {
  const availability = await providerForConnection(row).getModelAvailability(connectionCatalogFrom(row, settings))
  return new Set(availability?.unavailable.map(entry => entry.modelId))
}

async function isRunnable(resolved: ResolvedConnection, settings: AppSettings): Promise<boolean> {
  return !(await unavailableModelIds(resolved.connection, settings)).has(resolved.wireModel)
}

// The connection's default for this purpose when it can run, else the best
// model it can run; null when it can run nothing.
async function runnableDefaultForConnection(row: ConnectionRow, purpose: 'agent' | 'summarizer', settings: AppSettings) {
  const preferred = defaultSelectionForConnection(row, purpose, settings)
  const unavailable = await unavailableModelIds(row, settings)
  if (!preferred || !unavailable.has(preferred.wireModel)) return preferred
  const model = bestAllowedModel(connectionCatalogFrom(row, settings), m => unavailable.has(m.id))
  return model ? { llmProviderId: row.id, model: model.id, wireModel: model.id, connection: row, provider: preferred.provider } : null
}

/**
 * The model a run uses: the first candidate that resolves (an explicit pick,
 * the trigger's or session's model, the agent default), then the global
 * default, then the global connection's own default. A model the provider
 * says cannot run now counts as unset, like a retired one, so the list keeps
 * going. With nothing runnable the global default stands, and the provider's
 * refusal says why.
 *
 * A candidate may be a function, called only when every candidate before it
 * fell through: one that costs a read (the agent's preferences) is then paid
 * for only by the runs that need it.
 */
export async function resolveSelectionHierarchy(
  ...candidates: (SelectionCandidate | (() => Promise<SelectionCandidate>))[]
): Promise<ResolvedConnection> {
  return resolveSelectionHierarchyFrom(await getSettings(), ...candidates)
}

/** {@link resolveSelectionHierarchy} against settings the caller already read for this operation. */
export async function resolveSelectionHierarchyFrom(
  settings: AppSettings,
  ...candidates: (SelectionCandidate | (() => Promise<SelectionCandidate>))[]
): Promise<ResolvedConnection> {
  for (const candidate of candidates) {
    const resolved = await resolveConnectionSelection(typeof candidate === 'function' ? await candidate() : candidate, true, undefined, settings)
    if (resolved && await isRunnable(resolved, settings)) return resolved
  }
  const root = await resolveGlobalSelection(undefined, settings)
  if (!root) throw new Error('Configure a global default connection and model in Settings → LLM')
  if (await isRunnable(root, settings)) return root
  return (await runnableDefaultForConnection(root.connection, 'agent', settings)) ?? root
}

export const resolveExecutionSelection = resolveSelectionHierarchy

export function isHelperSelection(selection: ResolvedConnection | null): selection is ResolvedConnection {
  return selection !== null && selection.connection.userId === null && selection.provider.supportsDirectApi
}

/** One reason, in enforcement order, for both the API and the settings tooltip. */
function connectionDeletionReason(row: ConnectionRow, viewer: ConnectionViewer, root: ResolvedConnection | null, settings: AppSettings): string | undefined {
  if (row.userId === null ? !viewer.admin : row.userId !== viewer.userId)
    return row.userId ? 'Only the owner can delete this provider.' : 'Only an administrator can delete global providers.'
  if (root?.llmProviderId === row.id) return 'Change the app default before deleting this connection'
  if (row.managed && providerForConnection(row).apiKeyStatusFrom(settings).isConfigured)
    return 'Disconnect Platform before deleting this provider.'
  if (root?.provider.supportsDirectApi === false && settings.llmSummarizer?.llmProviderId === row.id)
    return 'Choose another API-capable summarizer before deleting this connection'
  return undefined
}

/** A retired/disabled helper model follows the same account's summarizer default. */
export async function resolveSummarizerSelection(read?: ReadConnections, settings?: AppSettings): Promise<ResolvedConnection | null> {
  const current = settings ?? await getSettings()
  const saved = current.llmSummarizer
  const selected = await resolveConnectionSelection(saved, false, read, current)
  if (isHelperSelection(selected)) return selected
  const row = saved ? await connectionRow(saved.llmProviderId, read) : null
  if (!row || row.userId !== null || !providerForConnection(row).supportsDirectApi) return null
  return defaultSelectionForConnection(row, 'summarizer', current)
}

// A helper the provider says cannot run now falls back to its connection's summarizer default.
async function runnableHelper(selection: ResolvedConnection, settings: AppSettings): Promise<ResolvedConnection> {
  if (await isRunnable(selection, settings)) return selection
  return (await runnableDefaultForConnection(selection.connection, 'summarizer', settings)) ?? selection
}

export async function resolveHelperSelection(): Promise<ResolvedConnection> {
  const settings = await getSettings()
  const override = await resolveSummarizerSelection(undefined, settings)
  if (isHelperSelection(override)) return runnableHelper(override, settings)
  const root = await resolveGlobalSelection(undefined, settings)
  if (isHelperSelection(root)) return runnableHelper(root, settings)
  if (!root) throw new HelperConfigurationError('Configure a global default provider and model in Settings → Model Providers')
  throw new HelperConfigurationError()
}
