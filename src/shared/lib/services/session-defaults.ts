/**
 * What a new session of an agent starts with, from one read of the settings.
 *
 * Every place that starts a session (the session route, an agent invoking
 * another, a scheduled run, a webhook trigger, a chat's first message, a
 * widget repair) reads the settings once at its boundary and passes them
 * here: the models, the agent's preferences, the limits, the custom env and
 * the runtime the session's pick resolves to all come from that one read.
 * The result belongs to that one start; the next start (the next scheduled
 * run included) reads again.
 */
import {
  effectiveModelsFrom,
  type AgentLimitsSettings,
  type AppSettings,
  type ModelSettings,
} from '@shared/lib/config/settings'
import { resolveConnectionRuntimeInherit } from '@shared/lib/llm-provider/connection-runtime'
import type { AgentPreferences } from '@shared/lib/types/agent-preferences'
import { readAgentPreferences } from './agent-preferences-service'

/** A surface's own runtime pick: the session's, a task's, a trigger's or an integration's. */
export type SessionRuntimePick = Parameters<typeof resolveConnectionRuntimeInherit>[0]
export type ResolvedSessionRuntime = Awaited<ReturnType<typeof resolveConnectionRuntimeInherit>>

export interface SessionDefaults {
  /** The app's models, catalog defaults applied. */
  models: ModelSettings
  /** The agent's preferences, its default model resolved against the connections. */
  agentPrefs: AgentPreferences
  agentLimits: AgentLimitsSettings
  /** The user's custom env vars for agents; undefined when there are none. */
  customEnvVars: Record<string, string> | undefined
  maxBrowserTabs: number | undefined
  /**
   * The model, connection, effort and speed a pick resolves to: the pick,
   * else the agent's default, else the app's. `{}` is what the agent's next
   * default session runs on (the prewarm).
   */
  resolve(pick?: SessionRuntimePick): Promise<ResolvedSessionRuntime>
}

export async function resolveSessionDefaults(settings: AppSettings, agentSlug: string): Promise<SessionDefaults> {
  const agentPrefs = await readAgentPreferences(agentSlug, settings)
  const models = effectiveModelsFrom(settings)
  const customEnvVars = settings.customEnvVars ?? {}
  return {
    models,
    agentPrefs,
    agentLimits: settings.agentLimits ?? {},
    customEnvVars: Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined,
    maxBrowserTabs: settings.app?.maxBrowserTabs,
    resolve: (pick = {}) => resolveConnectionRuntimeInherit(pick, agentPrefs, models, settings),
  }
}
