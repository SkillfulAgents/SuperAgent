import { z } from 'zod'

export const AGENT_CRON_TASK_TYPE = 'agent.cron'

/** One schedule's local wakeup: which schedule, and the occurrence it was set for. */
export const agentCronPayloadSchema = z.object({
  scheduleId: z.string(),
  scheduledFor: z.number(),
})
export type AgentCronPayload = z.infer<typeof agentCronPayloadSchema>

export function agentCronJobId(scheduleId: string): string {
  return `cron:${scheduleId}`
}
