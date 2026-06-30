import { z } from 'zod'

export const miniAppSessionRequestSchema = z.object({
  initData: z.string().min(1),
  integrationId: z.string().min(1),
  agentSlug: z.string().min(1),
  dashboardSlug: z.string().min(1),
})
