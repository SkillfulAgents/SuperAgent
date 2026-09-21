import { parseConnectionJson } from './connection-schema'
import { getSettings } from '../config/settings'
import { getRequestUserId } from '../platform-attribution/request-context'
import { resolveRuntimeInherit } from '../container/runtime-options'
import type { AgentPreferences } from '../types/agent-preferences'
import { subagentModelCatalogSchema } from '../container/subagent-model-catalog'
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
    connectionId?: string | null
    effort?: unknown
    speed?: unknown
  },
  agent: Partial<AgentPreferences> | null | undefined,
  models: unknown
) {
  const knobs = resolveRuntimeInherit(surface, agent, models)
  if (!getSettings().llmDefault) return knobs
  const resolved = await resolveSelectionHierarchy(
    storedSelection(surface.model, surface.connectionId),
    storedSelection(agent?.defaultModel, agent?.defaultConnectionId)
  )
  return { ...knobs, model: resolved.model, connectionId: resolved.connectionId }
}

/** Enforce selection access only for an explicit new binding. An attached
 * personal connection can be continued by every existing session collaborator.
 */
export async function assertConnectionSelectionAccess(
  connectionId: string | null | undefined,
  currentId?: string | null
) {
  if (!connectionId) return
  const row = await getConnection(connectionId)
  if (!row) return // Missing references inherit; existence is not authorization.
  if (
    !canSelectConnection(
      row,
      { userId: getRequestUserId() ?? null, admin: false },
      currentId ?? undefined
    )
  ) {
    throw new Error('Connection not found')
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
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
  'ENABLE_TOOL_SEARCH',
] as const

export async function connectionRuntime(resolved: ResolvedConnection, agentId: string) {
  const { connection, provider, wireModel } = resolved
  const catalog = connectionCatalog(connection)
  const model = catalog.find((m) => m.id === wireModel)!
  const subagent = (selection: string | null) =>
    resolveSelection(selection ? { connectionId: connection.id, model: selection } : null, [
      { id: connection.id, catalog },
    ])?.wireModel ?? wireModel
  const env = Object.fromEntries(LLM_ENV_KEYS.map((key) => [key, '']))
  for (const [key, value] of Object.entries(await provider.getContainerEnvVars({ id: agentId }))) {
    env[key] = value ?? ''
  }
  Object.assign(env, parseConnectionJson(connectionConfigSchema, connection.config).runtimeEnv)
  env.ENABLE_TOOL_SEARCH =
    getSettings().enableToolSearch === false ? 'false' : (provider.toolSearchEnv ?? '')
  return {
    connectionId: connection.id,
    generation: connection.generation,
    provider: provider.id,
    model: wireModel,
    browserModel: subagent(connection.browserModel),
    dashboardBuilderModel: subagent(connection.dashboardModel),
    modelPromptHints: model.promptHints ?? [],
    subagentModels: subagentModelCatalogSchema.parse(
      catalog.filter((m) => m.isLatest).slice(0, 32)
    ),
    modelContextWindows: Object.fromEntries(
      catalog.filter((m) => m.contextWindow).map((m) => [m.id, m.contextWindow!])
    ),
    env,
  }
}
export type ConnectionRuntime = Awaited<ReturnType<typeof connectionRuntime>>

const sessionRuntimes = new Map<string, ConnectionRuntime>()
export function rememberSessionRuntime(
  agentId: string,
  sessionId: string,
  runtime: ConnectionRuntime
): void {
  // Retain only non-secret execution facts for presentation/accounting.
  sessionRuntimes.set(`${agentId}:${sessionId}`, { ...runtime, env: {} })
  if (sessionRuntimes.size > 500) sessionRuntimes.delete(sessionRuntimes.keys().next().value!)
}
export function sessionRuntime(agentId: string, sessionId: string): ConnectionRuntime | undefined {
  return sessionRuntimes.get(`${agentId}:${sessionId}`)
}

const selectionTurns = new Map<string, Promise<unknown>>()
export async function withSessionSelection<T>(
  agentId: string,
  sessionId: string,
  work: () => Promise<T>
): Promise<T> {
  const key = `${agentId}:${sessionId}`
  const previous = selectionTurns.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(work)
  selectionTurns.set(key, current)
  try {
    return await current
  } finally {
    if (selectionTurns.get(key) === current) selectionTurns.delete(key)
  }
}
