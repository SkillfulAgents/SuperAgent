import { z } from 'zod'

export const workspaceUnavailableBodySchema = z.object({
  error: z.union([
    z.literal('deployment_unavailable'),
    z.literal('The request could not reach your workspace. Please retry.'),
  ]),
})
