import { z } from 'zod'

export const secretHomeNameSchema = z.string().trim().min(1).max(60)

/**
 * Secrets the user chose to list on the agent home, keyed by env var. A secret
 * is only a name and a value, so the user names the service it belongs to.
 */
export const secretConnectionsSchema = z.record(
  z.string(),
  z.object({ name: secretHomeNameSchema }).loose(),
)

export type SecretConnections = z.infer<typeof secretConnectionsSchema>
