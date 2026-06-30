import { z } from 'zod'

export const shareDashboardRequestSchema = z.object({
  slug: z.string().min(1),
  integration_id: z.string().min(1).optional(),
  chat_id: z.string().min(1).optional(),
  // Optional presentation: a fitting emoji + a short one-line blurb the agent
  // supplies so the share card reads as a card rather than a bare name.
  emoji: z.string().max(16).optional(),
  caption: z.string().max(160).optional(),
})
