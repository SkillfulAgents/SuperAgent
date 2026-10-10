import { z } from 'zod'
import { runtimeOptionFields } from '@shared/lib/container/runtime-options'

// Keep in sync with agent-container/src/file-hooks/agent-preferences-hook.ts
export const agentPreferencesSchema = z.object({
  /** Days of inactivity after which sessions are deleted. 0 = Never. */
  autoDeleteInactiveDays: z.number().int().nonnegative().optional(),
  /** Days after which this agent's API / MCP audit rows are deleted. 0 = Never. */
  apiLogAutoDeleteDays: z.number().int().nonnegative().optional(),
  /** Default model for new sessions — a concrete id (pinned) or a bare family alias (latest). Overrides the global default; per-session/trigger picks still win. */
  defaultLlmProviderId: runtimeOptionFields.llmProviderId.nullish(),
  defaultModel: runtimeOptionFields.model.optional(),
  /** Default effort for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultEffort: runtimeOptionFields.effort.optional(),
  /** Default processing speed for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultSpeed: runtimeOptionFields.speed.optional(),
})

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>

/**
 * PUT /api/agents/:id/preferences body: each field optional, `null` clears it
 * back to the app-wide default. Unknown keys are stripped.
 */
export const agentPreferencesUpdateSchema = z.object({
  autoDeleteInactiveDays: z.number().int().nonnegative().nullish(),
  apiLogAutoDeleteDays: z.number().int().nonnegative().nullish(),
  defaultLlmProviderId: runtimeOptionFields.llmProviderId.nullish(),
  defaultModel: runtimeOptionFields.model.nullish(),
  defaultEffort: runtimeOptionFields.effort.nullish(),
  defaultSpeed: runtimeOptionFields.speed.nullish(),
})

export type AgentPreferencesUpdate = z.infer<typeof agentPreferencesUpdateSchema>
