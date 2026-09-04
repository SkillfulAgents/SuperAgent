import { z } from 'zod'

// Fallback contract for ingress workers that predate the header; the header
// (WORKSPACE_UNAVAILABLE_HEADER) is the primary signal.
export const workspaceUnavailableStateSchema = z.enum([
  'waking',
  'sleeping',
  'error',
  'unreachable',
])
export type WorkspaceUnavailableState = z.infer<typeof workspaceUnavailableStateSchema>

export const workspaceUnavailableBodySchema = z.object({
  error: z.literal('deployment_unavailable'),
  state: workspaceUnavailableStateSchema,
})
