import { z } from 'zod'

/**
 * Request body schema for the Electron host-browser control routes
 * (`/api/browser/launch-host-browser`, `/stop-host-browser`, `/debug-info`).
 *
 * `agentId` is optional and, when present, must match the agent slug resolved
 * from the caller's proxy token (enforced in the route handlers — see SUP-216).
 * The effective agent acted upon is ALWAYS the token's slug, never the raw body
 * value, so a container holding one agent's token cannot drive another agent's
 * host browser.
 */
export const hostBrowserRequestSchema = z.object({
  agentId: z.string().min(1).optional(),
})

export type HostBrowserRequest = z.infer<typeof hostBrowserRequestSchema>
