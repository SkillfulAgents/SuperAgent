import { z } from 'zod'

export const dashboardCookiePayloadSchema = z.object({
  userId: z.string(),
  agentSlug: z.string(),
  dashboardSlug: z.string(),
  integrationId: z.string(),
  exp: z.number(),
})

export type DashboardCookiePayload = z.infer<typeof dashboardCookiePayloadSchema>
export const DASHBOARD_COOKIE_NAME = 'tg_dash'
export const DASHBOARD_COOKIE_TTL_SECONDS = 900
