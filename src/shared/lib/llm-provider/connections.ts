import { withGlobalModelPricing } from './global-pricing'
import { connectionCatalogSchema } from './connection-schema'
import { parseConnectionJson } from './connection-schema'
import { randomUUID } from 'node:crypto'
import { legacyConnectionId, providerCredentialFields } from './provider-settings'
import { changesOf } from '../db/batch'
import { sql, and, eq, isNull, or } from 'drizzle-orm'
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
  connectionCredentialsSchema,
  connectionInputSchema,
  modelSelectionSchema,
  resolveSelection,
  type ConnectionInfo,
  type ModelSelection,
} from './connection-schema'

export type ConnectionRow = typeof llmConnections.$inferSelect
export type ConnectionViewer = { userId: string | null; admin: boolean }
const providerSchema = z.enum(LLM_PROVIDER_IDS)

export function providerForConnection(
  row: Pick<ConnectionRow, 'provider' | 'config' | 'credentials'>
) {
  const config = parseConnectionJson(connectionConfigSchema, row.config)
  const apiKeys = { ...config.apiKeys }
  if (row.credentials) {
    const credential = parseConnectionJson(connectionCredentialsSchema, row.credentials)
    const key = providerCredentialFields[providerSchema.parse(row.provider)][0]
    if (key) apiKeys[key] = credential.accessToken
  }
  return createLlmProvider(providerSchema.parse(row.provider), {
    apiKeys,
    env: Object.fromEntries(
      Object.entries(config.env).map(([key, name]) => [key, process.env[name]])
    ),
  })
}

export async function getConnection(id: string): Promise<ConnectionRow | null> {
  return (await db.select().from(llmConnections).where(eq(llmConnections.id, id)).get()) ?? null
}

export function connectionCatalog(row: Pick<ConnectionRow, 'catalog'>): ModelDefinition[] {
  return withGlobalModelPricing(parseConnectionJson(connectionCatalogSchema, row.catalog), getSettings().modelPricing)
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
      state: row.state,
      catalog: connectionCatalog(row),
      browserModel: row.browserModel,
      dashboardModel: row.dashboardModel,
      baseUrl: config.apiKeys.genericBaseUrl,
      region: config.apiKeys.bedrockRegion,
      canManage,
      canDelete:
        canManage &&
        getSettings().llmDefault?.connectionId !== row.id &&
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
  const catalog = connectionCatalogSchema.parse(
    input.catalog ??
      (previous ? connectionCatalog(previous) : getLlmProvider(input.provider).getBuiltinCatalog())
  )
  return { input, previous, config, catalog }
}

export async function saveConnection(
  raw: unknown,
  viewer: ConnectionViewer,
  id?: string
): Promise<string> {
  return mutateConnections(async () => {
    const { input, previous, config, catalog } = await prepareConnection(raw, viewer, id)
    const connectionId = id ?? randomUUID()
    const root = getSettings().llmDefault
    if (
      root?.connectionId === connectionId &&
      !resolveSelection(root, [{ id: connectionId, catalog }])
    ) {
      throw new Error('Change the app default before removing its model')
    }
    const credentialsChanged = providerCredentialFields[input.provider].some(
      (key) =>
        key !== 'genericBaseUrl' &&
        key !== 'bedrockRegion' &&
        Object.hasOwn(input.config.apiKeys, key)
    )
    const values = {
      name: input.name,
      provider: input.provider,
      userId: input.userId,
      config: JSON.stringify(config),
      catalog: JSON.stringify(catalog),
      browserModel: input.browserModel ?? null,
      dashboardModel: input.dashboardModel ?? null,
      state: credentialsChanged ? ('ready' as const) : (previous?.state ?? ('ready' as const)),
      ...(credentialsChanged ? { credentials: null } : {}),
      updatedAt: new Date(),
    }
    if (previous) {
      const updated = await db
        .update(llmConnections)
        .set({
          ...values,
          generation: sql`${llmConnections.generation} + 1`,
          refreshLease: null,
          refreshLeaseUntil: null,
        })
        .where(eq(llmConnections.id, connectionId))
        .run()
      if (!changesOf(updated)) throw new Error('Connection no longer exists')
    } else {
      await db
        .insert(llmConnections)
        .values({ ...values, id: connectionId, createdAt: new Date() })
        .run()
    }
    return connectionId
  })
}

export async function deleteConnection(id: string, viewer: ConnectionViewer): Promise<void> {
  await mutateConnections(async () => {
    const row = await getConnection(id)
    if (!row) throw new Error('Connection not found')
    assertManageConnection(row, viewer)
    if (getSettings().llmDefault?.connectionId === id)
      throw new Error('Change the app default before deleting this connection')
    if (row.managed && providerForConnection(row).getApiKeyStatus().isConfigured)
      throw new Error('Platform cannot be deleted while connected')
    await db.delete(llmConnections).where(eq(llmConnections.id, id)).run()
    if (id === legacyConnectionId(providerSchema.parse(row.provider))) {
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

export async function resolveConnectionSelection(selection: ModelSelection | null | undefined) {
  if (!selection) return null
  let row = await getConnection(selection.connectionId)
  if (!row) return null
  if (legacySelections.has(selection)) {
    // An absent ID is pre-upgrade file data, not a deleted binding. Preserve
    // the old alias/passthrough semantics once, before the strict resolver.
    const wire = resolveModelForProvider(
      selection.model,
      providerSchema.parse(row.provider),
      'agent'
    )
    if (!resolveSelection(selection, [{ id: row.id, catalog: connectionCatalog(row) }])) {
      selection = { connectionId: row.id, model: wire }
      while (!connectionCatalog(row).some((model) => model.id === wire)) {
        const catalog = connectionCatalogSchema.parse([
          ...connectionCatalog(row),
          { id: wire, label: wire, supportedEfforts: ['low', 'medium', 'high'] },
        ])
        const result = await db
          .update(llmConnections)
          .set({ catalog: JSON.stringify(catalog), generation: row.generation + 1 })
          .where(and(eq(llmConnections.id, row.id), eq(llmConnections.generation, row.generation)))
          .run()
        const current = await getConnection(row.id)
        if (!current) return null
        row = current
        if (changesOf(result)) break
      }
    }
  }
  const resolved = resolveSelection(selection, [{ id: row.id, catalog: connectionCatalog(row) }])
  return resolved ? { ...resolved, connection: row, provider: providerForConnection(row) } : null
}
export type ResolvedConnection = NonNullable<Awaited<ReturnType<typeof resolveConnectionSelection>>>

const legacySelections = new WeakSet<ModelSelection>()

/** Undefined ID is legacy data. Explicit NULL is a cleared/deleted binding. */
export function storedSelection(
  model?: string | null,
  connectionId?: string | null
): ModelSelection | null {
  if (!model || connectionId === null) return null
  const id = connectionId ?? getSettings().llmLegacyConnectionId
  if (!id) return null
  const selection = { connectionId: id, model }
  if (connectionId === undefined) legacySelections.add(selection)
  return selection
}

export async function resolveSelectionHierarchy(
  ...candidates: (ModelSelection | null | undefined)[]
): Promise<ResolvedConnection> {
  for (const candidate of candidates) {
    const resolved = await resolveConnectionSelection(candidate)
    if (resolved) return resolved
  }
  const root = await resolveConnectionSelection(getSettings().llmDefault)
  if (!root || root.connection.userId !== null)
    throw new Error('Configure a global default connection and model in Settings → LLM')
  return root
}

export async function resolveExecutionSelection(
  ...candidates: (ModelSelection | null | undefined)[]
): Promise<ResolvedConnection> {
  return withCurrentCredentials(await resolveSelectionHierarchy(...candidates))
}

export async function resolveHelperSelection(): Promise<ResolvedConnection> {
  const override = await resolveConnectionSelection(getSettings().llmSummarizer)
  if (override?.connection.userId === null) return withCurrentCredentials(override)
  return resolveExecutionSelection()
}

/** Refresh only for execution; UI/reference reads never trigger an exchange. */
export async function withCurrentCredentials(
  selection: ResolvedConnection
): Promise<ResolvedConnection> {
  if (!selection.connection.credentials) return selection
  const { getAccessCredential } = await import('./connection-credentials')
  await getAccessCredential(selection.connectionId)
  const current = await getConnection(selection.connectionId)
  if (!current) throw new Error('Connection no longer exists')
  return { ...selection, connection: current, provider: providerForConnection(current) }
}
