import { z } from 'zod'

export const shareDashboardRequestSchema = z.object({
  slug: z.string().min(1),
  integration_id: z.string().min(1).optional(),
  chat_id: z.string().min(1).optional(),
})
