import { z } from 'zod'

export const inboundXAgentCallerSchema = z.object({
  slug: z.string(),
  displaySlug: z.string(),
  name: z.string(),
  decision: z.enum(['allow', 'review']),
  canAccess: z.boolean(),
})

export const inboundXAgentSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  triggeredBy: z.object({
    slug: z.string(),
    name: z.string(),
  }),
})

export const inboundXAgentDetailsSchema = z.object({
  sessions: z.array(inboundXAgentSessionSchema),
  callers: z.array(inboundXAgentCallerSchema),
})

export type InboundXAgentCaller = z.infer<typeof inboundXAgentCallerSchema>
export type InboundXAgentSession = z.infer<typeof inboundXAgentSessionSchema>
export type InboundXAgentDetails = z.infer<typeof inboundXAgentDetailsSchema>
