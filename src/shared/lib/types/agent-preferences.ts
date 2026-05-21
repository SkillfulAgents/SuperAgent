import { z } from 'zod'

// Keep in sync with agent-container/src/file-hooks/agent-preferences-hook.ts
export const agentPreferencesSchema = z.object({
  autoDeleteInactiveDays: z.number().int().positive().optional(),
})

export type AgentPreferences = z.infer<typeof agentPreferencesSchema>
