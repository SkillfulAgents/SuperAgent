import { getModelContextWindowMap } from './model-catalog'
import { LlmProviderNotFoundError } from '../agent-runtime-errors/llm-provider-not-found/llm-provider-not-found-error'
import { getContainerModelPromptHints } from '../container/resolve-model'
import { parseConnectionJson } from './connection-schema'
import { getSettings } from '../config/settings'
import { getRequestUserId } from '../platform-attribution/request-context'
import { resolveRuntimeInherit } from '../container/runtime-options'
import type { AgentPreferences } from '../types/agent-preferences'
import { getSubagentModelCatalog } from '../container/subagent-model-catalog'
import { connectionConfigSchema, resolveSelection } from './connection-schema'
import {
  storedSelection,
  resolveSelectionHierarchy,
  connectionCatalog,
  getConnection,
  canSelectConnection,
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
  models: unknown
) {
  const knobs = resolveRuntimeInherit(surface, agent, models)
  if (!getSettings().llmDefault) return knobs
  const resolved = await resolveSelectionHierarchy(
    storedSelection(surface.model, surface.llmProviderId),
    storedSelection(agent?.defaultModel, agent?.defaultLlmProviderId)
  )
  return { ...knobs, model: resolved.model, llmProviderId: resolved.llmProviderId }
}

/**
 * Bind a model an agent names for an automation (a catalog id or a family
 * alias such as `sonnet`) to the connection the agent runs on. The name is
 * saved as given, so a family alias keeps following the family's latest model.
 * Throws with the valid ids when the connection has no such model, so the
 * agent can retry instead of the automation silently running on a default.
 */
export async function bindAgentModelChoice(
  model: string | undefined,
  agent: Partial<AgentPreferences> | null | undefined
): Promise<{ model?: string; llmProviderId?: string }> {
  if (!model || !getSettings().llmDefault) return { model }
  const { connection } = await resolveSelectionHierarchy(
    storedSelection(agent?.defaultModel, agent?.defaultLlmProviderId)
  )
  const catalog = connectionCatalog(connection)
  const picked = resolveSelection({ llmProviderId: connection.id, model }, [{ id: connection.id, catalog }])
  if (!picked) {
    const ids = catalog.map((m) => m.id)
    throw new Error(`Unknown model "${model}". Models available to this agent: ${ids.join(', ')}. Leave out model to use the agent's default.`)
  }
  return { model, llmProviderId: connection.id }
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

export async function connectionRuntime(resolved: ResolvedConnection, agentId: string) {
  const { connection, provider, wireModel } = resolved
  const catalog = connectionCatalog(connection)
  // Models the provider says cannot run now (e.g. the plan excludes them) count
  // as unset: a helper model falls back to the main one, and subagents are not offered them.
  const availability = await provider.getModelAvailability(catalog)
  const unavailable = new Set(availability?.unavailable.map(entry => entry.modelId))
  const runnableCatalog = catalog.filter(model => !unavailable.has(model.id))
  const subagent = (selection: string | null) =>
    resolveSelection(selection ? { llmProviderId: connection.id, model: selection } : null, [
      { id: connection.id, catalog: runnableCatalog },
    ])?.wireModel ?? wireModel
  const env = Object.fromEntries(LLM_ENV_KEYS.map((key) => [key, '']))
  for (const [key, value] of Object.entries(await provider.getContainerEnvVars({ id: agentId }))) {
    if (value !== undefined) env[key] = value
  }
  const runtimeEnv = parseConnectionJson(connectionConfigSchema, connection.config).runtimeEnv
  Object.assign(env, runtimeEnv)
  env.ENABLE_TOOL_SEARCH =
    getSettings().enableToolSearch === false ? 'false' : (runtimeEnv.ENABLE_TOOL_SEARCH ?? provider.toolSearchEnv ?? '')
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
