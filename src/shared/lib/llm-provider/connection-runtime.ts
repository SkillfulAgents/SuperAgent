import { getModelContextWindowMap } from './model-catalog'
import { getContainerModelPromptHints } from '../container/resolve-model'
import { parseConnectionJson } from './connection-schema'
import { getSettings } from '../config/settings'
import { getRequestUserId } from '../platform-attribution/request-context'
import { resolveRuntimeInherit } from '../container/runtime-options'
import type { AgentPreferences } from '../types/agent-preferences'
import { getSubagentModelCatalog } from '../container/subagent-model-catalog'
import { subscriptionMediaPrompt } from '../subscription-media'
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

/** Enforce selection access only for an explicit new binding. An attached
 * personal connection can be continued by every existing session collaborator.
 */
export class LlmSelectionAccessError extends Error {
  constructor() { super('LLM provider not found') }
}

export async function assertConnectionSelectionAccess(
  llmProviderId: string | null | undefined,
  currentId?: string | null
) {
  if (!llmProviderId) return
  const row = await getConnection(llmProviderId)
  if (!row) throw new LlmSelectionAccessError()
  if (
    !canSelectConnection(
      row,
      { userId: getRequestUserId() ?? null, admin: false },
      currentId ?? undefined
    )
  ) {
    throw new LlmSelectionAccessError()
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
  const subagent = (selection: string | null) =>
    resolveSelection(selection ? { llmProviderId: connection.id, model: selection } : null, [
      { id: connection.id, catalog },
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
    modelPromptHints: getContainerModelPromptHints(wireModel, catalog),
    subagentModels: getSubagentModelCatalog(catalog),
    modelContextWindows: getModelContextWindowMap(catalog),
    env,
    extraSystemPrompt: await subscriptionMediaPrompt(agentId),
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
  sessionRuntimes.set(`${agentId}:${sessionId}`, { ...runtime, env: {}, proxy: undefined })
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
