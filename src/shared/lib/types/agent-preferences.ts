import { z } from 'zod'
import { modelSelectionFields } from '@shared/lib/model-selection'

// Keep in sync with agent-container/src/file-hooks/agent-preferences-hook.ts
export const agentPreferencesSchema = z.object({
  /** Days of inactivity after which sessions are deleted. 0 = Never. */
  autoDeleteInactiveDays: z.number().int().nonnegative().optional(),
  /** Days after which this agent's API / MCP audit rows are deleted. 0 = Never. */
  apiLogAutoDeleteDays: z.number().int().nonnegative().optional(),
  /** Default model for new sessions — a concrete id (pinned) or a bare family alias (latest). Overrides the global default; per-session/trigger picks still win. */
  defaultLlmProviderId: modelSelectionFields.llmProviderId.nullish(),
  defaultModel: modelSelectionFields.model.optional(),
  /** Default effort for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultEffort: modelSelectionFields.effort.optional(),
  /** Default processing speed for new sessions. Overrides the global default; per-session/trigger picks still win. */
  defaultSpeed: modelSelectionFields.speed.optional(),
})

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>

/**
 * PUT /api/agents/:id/preferences body: each field optional, `null` clears it
 * back to the app-wide default. Unknown keys are stripped.
 */
export const agentPreferencesUpdateSchema = z.object({
  autoDeleteInactiveDays: z.number().int().nonnegative().nullish(),
  apiLogAutoDeleteDays: z.number().int().nonnegative().nullish(),
  defaultLlmProviderId: modelSelectionFields.llmProviderId.nullish(),
  defaultModel: modelSelectionFields.model.nullish(),
  defaultEffort: modelSelectionFields.effort.nullish(),
  defaultSpeed: modelSelectionFields.speed.nullish(),
})

export type AgentPreferencesUpdate = z.infer<typeof agentPreferencesUpdateSchema>
