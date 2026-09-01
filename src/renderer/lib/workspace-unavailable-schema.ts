import { z } from 'zod'

// Fallback contract for ingress workers that predate the header; the header
// (WORKSPACE_UNAVAILABLE_HEADER) is the primary signal.
export const workspaceUnavailableBodySchema = z.object({
  error: z.union([
    z.literal('deployment_unavailable'),
    z.literal('The request could not reach your workspace. Please retry.'),
  ]),
  state: z.string().optional(),
})
