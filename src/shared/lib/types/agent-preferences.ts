import { z } from 'zod'
import { EFFORT_LEVELS, SPEED_LEVELS } from '@shared/lib/container/types'

// Keep in sync with agent-container/src/file-hooks/agent-preferences-hook.ts
export const agentPreferencesSchema = z.object({
  autoDeleteInactiveDays: z.number().int().positive().optional(),
  /** Default model for new sessions — a concrete id (pinned) or a bare family alias (latest). Overrides the global default; per-session/trigger picks still win. */
  defaultModel: z.string().trim().min(1).optional(),
  /** Default effort for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultEffort: z.enum(EFFORT_LEVELS).optional(),
  /** Default processing speed for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultSpeed: z.enum(SPEED_LEVELS).optional(),
})

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>

/**
 * PUT /api/agents/:id/preferences body: each field optional, `null` clears it
 * back to the app-wide default. Unknown keys are stripped.
 */
export const agentPreferencesUpdateSchema = z.object({
  autoDeleteInactiveDays: z.number().int().positive().nullish(),
  defaultModel: z.string().trim().min(1).nullish(),
  defaultEffort: z.enum(EFFORT_LEVELS).nullish(),
  defaultSpeed: z.enum(SPEED_LEVELS).nullish(),
})

export type AgentPreferencesUpdate = z.infer<typeof agentPreferencesUpdateSchema>
