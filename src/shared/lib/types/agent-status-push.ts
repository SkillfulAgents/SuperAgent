import { z } from 'zod'

/**
 * What the tray and the Agents menu show for one agent, and the message the
 * main window sends Electron main to keep them current without a poll of
 * main's own. See src/main/agent-status-source.ts.
 */

export const agentStatusEntrySchema = z.object({
  slug: z.string().min(1).max(512),
  name: z.string().max(1024),
  activityStatus: z.enum(['sleeping', 'idle', 'working', 'awaiting_input']),
})

/**
 * The window's agents, in the order it lists them, for the Superagent it
 * settled on at boot. `null` withdraws the window's list (its agents query
 * failed, or it is going away): main goes back to asking the API itself.
 */
export const agentStatusPushSchema = z
  .object({
    target: z.enum(['local', 'cloud']),
    agents: z.array(agentStatusEntrySchema).max(10_000),
  })
  .nullable()

export type AgentStatusEntry = z.infer<typeof agentStatusEntrySchema>
export type AgentStatusPush = z.infer<typeof agentStatusPushSchema>
