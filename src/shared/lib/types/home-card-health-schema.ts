import { z } from 'zod'
import {
  cronActivityPointSchema,
  dailyActivityPointSchema,
} from './activity-schema'

/**
 * Compact wire shape for the home card health carousel. The automation
 * descriptors contain only fields the cards render; graph status, counts,
 * topology, connection usage, and chat data stay out of this response.
 */
export const homeCardCronSchema = z.object({
  id: z.string(),
  agentSlug: z.string(),
  name: z.string().nullable(),
  scheduleExpression: z.string(),
})

export const homeCardWebhookSchema = z.object({
  id: z.string(),
  agentSlug: z.string(),
  triggerType: z.string(),
  name: z.string().nullable(),
})

export const homeCardHealthSchema = z.object({
  days: z.number(),
  generatedAt: z.string(),
  crons: z.array(homeCardCronSchema),
  webhooks: z.array(homeCardWebhookSchema),
  cronByTaskId: z.record(z.string(), z.array(cronActivityPointSchema)),
  webhookByTriggerId: z.record(z.string(), z.array(dailyActivityPointSchema)),
})

export type HomeCardHealthData = z.infer<typeof homeCardHealthSchema>
export type HomeCardCron = z.infer<typeof homeCardCronSchema>
export type HomeCardWebhook = z.infer<typeof homeCardWebhookSchema>
