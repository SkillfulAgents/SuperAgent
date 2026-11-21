import { getModelContextWindowMap } from './model-catalog'
import { LlmProviderNotFoundError } from '../agent-runtime-errors/llm-provider-not-found/llm-provider-not-found-error'
import { getContainerModelPromptHints } from '../container/resolve-model'
import { parseConnectionJson } from './connection-schema'
import { getSettings, type AppSettings, type ModelSettings } from '../config/settings'
import { getRequestUserId } from '../platform-attribution/request-context'
import { resolveRuntimeInherit } from '../container/runtime-options'
import type { AgentPreferences } from '../types/agent-preferences'
import { getSubagentModelCatalog } from '../container/subagent-model-catalog'
import { connectionConfigSchema, resolveSelection } from './connection-schema'
import {
  storedSelection,
  resolveSelectionHierarchyFrom,
  connectionCatalogFrom,
  getConnection,
  canSelectConnection,
  selectableConnectionRows,
  type ConnectionRow,
  type ResolvedConnection,
} from './connections'

export async function resolveConnectionRuntimeInherit(
  surface: {
    model?: string | null
    llmProviderId?: string | null
    effort?: unknown
    speed?: unknown
  },
  agent: Partial<AgentPreferences> | null | undefined,
  models: ModelSettings,
  /** The operation's settings, when the caller already read them. */
  settings?: AppSettings,
) {
  const knobs = resolveRuntimeInherit(surface, agent, models)
  const current = settings ?? await getSettings()
  if (!current.llmDefault) return knobs
  const resolved = await resolveSelectionHierarchyFrom(
    current,
    await storedSelection(surface.model, surface.llmProviderId, current),
    await storedSelection(agent?.defaultModel, agent?.defaultLlmProviderId, current)
  )
  return { ...knobs, model: resolved.model, llmProviderId: resolved.llmProviderId, wireModel: resolved.wireModel,
    // What the catalog needs, never the row: its config holds the connection's credentials.
    connection: { name: resolved.connection.name, provider: resolved.connection.provider, modelOverrides: resolved.connection.modelOverrides } }
}

/**
 * Bind a model an agent names for a run (a catalog id or a family alias such
 * as `sonnet`) to a connection. Without `connection` it is the agent's own, as
 * a person picks in the composer; a named connection must be one the run's
 * person could pick there, checked as that person, or as no one when the run
 * has none. The name is saved as given, so an alias keeps following the
 * family's latest model. Refusals name no account and echo no input.
 */
export async function bindAgentModelChoice(
  { model, connection: named }: { model?: string; connection?: string },
  agent: Partial<AgentPreferences> | null | undefined,
  userId: string | undefined,
  /** The operation's settings, when the caller already read them. */
  settings?: AppSettings,
): Promise<{ model?: string; llmProviderId?: string }> {
  if (!model) {
    if (named) throw new Error('Name a model together with connection.')
    return {}
  }
  const current = settings ?? await getSettings()
  if (!current.llmDefault) {
    if (named) throw new Error('This app has no accounts to choose from. Leave out connection.')
    return { model }
  }
  const { connection: own } = await resolveSelectionHierarchyFrom(
    current,
    await storedSelection(agent?.defaultModel, agent?.defaultLlmProviderId, current)
  )
  const row = named ? await namedConnection(named, own.id, userId) : own
  const catalog = connectionCatalogFrom(row, current)
  if (!resolveSelection({ llmProviderId: row.id, model }, [{ id: row.id, catalog }])) {
    const ids = catalog.map((m) => m.id).join(', ')
    throw new Error(`Unknown model. Models on ${named ? 'that account' : "this agent's account"}: ${ids}. Leave out model to use the agent's default, or name another account with connection.`)
  }
  return { model, llmProviderId: row.id }
}

// By id, or by a name only one connection the person can pick has; checked as
// the composer checks a pick, for the person, or for no one.
async function namedConnection(named: string, ownId: string, userId: string | undefined): Promise<ConnectionRow> {
  const byId = await getConnection(named)
  const [row, ...more] = byId ? [byId] : (await selectableConnectionRows(userId, ownId)).filter((r) => r.name === named)
  if (more.length > 0) throw new Error('More than one account has that name. Name it by id.')
  if (!row || !canSelectConnection(row, { userId: userId ?? null, admin: false }, ownId)) {
    throw new Error('That account is not one you can use.')
  }
  return row
}

/** Enforce selection access only for an explicit new binding. An attached
 * personal connection can be continued by every existing session collaborator.
 */
/**
 * A session send's provider check, made before the session's stored binding
 * is known: whether the caller may bind `llmProviderId` only because the
 * session already holds it (another member's personal connection). The
 * delivery then refuses it unless the session still does. Throws when the
 * connection does not exist.
 */
export async function connectionNeedsAttachment(llmProviderId: string | null | undefined): Promise<boolean> {
  if (!llmProviderId) return false
  const row = await getConnection(llmProviderId)
  if (!row) throw new LlmProviderNotFoundError()
  return !canSelectConnection(row, { userId: getRequestUserId() ?? null, admin: false })
}

export async function assertConnectionSelectionAccess(
  llmProviderId: string | null | undefined,
  currentId?: string | null
) {
  if (!llmProviderId) return
  const row = await getConnection(llmProviderId)
  if (!row) throw new LlmProviderNotFoundError()
  if (
    !canSelectConnection(
      row,
      { userId: getRequestUserId() ?? null, admin: false },
      currentId ?? undefined
    )
  ) {
    throw new LlmProviderNotFoundError()
  }
}

// Clear the complete provider auth namespace before applying a selection, so
// switching to direct Anthropic cannot retain a prior endpoint or AWS mode.
export const LLM_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ENABLE_TOOL_SEARCH',
] as const

/**
 * The runtime a session on `resolved` gets. `settings`: the global settings
 * the operation (one send, one session start, one credential request) already
 * read; read here when absent. Never pass settings from an earlier operation.
 */
export async function connectionRuntime(resolved: ResolvedConnection, agentId: string, given?: AppSettings) {
  const { connection, provider, wireModel } = resolved
  const settings = given ?? await getSettings()
  const catalog = connectionCatalogFrom(connection, settings)
  // Models the provider says cannot run now (e.g. the plan excludes them) count
  // as unset: a helper model falls back to the main one, and subagents are not offered them.
  const availability = await provider.getModelAvailability(catalog, { settings })
  const unavailable = new Set(availability?.unavailable.map(entry => entry.modelId))
  const runnableCatalog = catalog.filter(model => !unavailable.has(model.id))
  const subagent = (selection: string | null) =>
    resolveSelection(selection ? { llmProviderId: connection.id, model: selection } : null, [
      { id: connection.id, catalog: runnableCatalog },
    ])?.wireModel ?? wireModel
  const env = Object.fromEntries(LLM_ENV_KEYS.map((key) => [key, '']))
  for (const [key, value] of Object.entries(await provider.getContainerEnvVars({ id: agentId }, settings))) {
    if (value !== undefined) env[key] = value
  }
  const runtimeEnv = parseConnectionJson(connectionConfigSchema, connection.config).runtimeEnv
  Object.assign(env, runtimeEnv)
  env.ENABLE_TOOL_SEARCH =
    settings.enableToolSearch === false ? 'false' : (runtimeEnv.ENABLE_TOOL_SEARCH ?? await provider.toolSearchEnv(wireModel))
  const configuredProxy = await provider.getContainerProxyConfig()
  // Static keys rotate with the connection row. Refreshable credentials carry
  // their own generation, which may be newer than this connection snapshot.
  const proxy = configuredProxy && configuredProxy.credential.expiresAt === undefined
    ? { ...configuredProxy, credential: { ...configuredProxy.credential, generation: connection.generation } }
    : configuredProxy
  return {
    ...(proxy ? { proxy } : {}),
    llmProviderId: connection.id,
    generation: connection.generation,
    provider: provider.id,
    model: wireModel,
    browserModel: subagent(connection.browserModel),
    dashboardBuilderModel: subagent(connection.dashboardModel),
    modelPromptHints: [...getContainerModelPromptHints(wireModel, catalog), ...(provider.mediaPrompt ? [provider.mediaPrompt] : [])],
    subagentModels: getSubagentModelCatalog(runnableCatalog),
    modelContextWindows: getModelContextWindowMap(catalog),
    env,
  }
}
export type ConnectionRuntime = Awaited<ReturnType<typeof connectionRuntime>>

export function credentialSource(provider: string | undefined): string {
  if (!provider) return 'unknown'
  return provider === 'platform' ? 'platform' : `byo:${provider}`
}
