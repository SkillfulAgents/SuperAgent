import { z } from 'zod'

/**
 * The agent's runtime surface, resolved by the host and injected into the system
 * prompt. Exported so host-side link builders reuse the same shape rather than
 * re-resolving. `web` covers any browser-reached host - hosted cloud AND
 * self-hosted; `publicUrl` is present only when the host has a public URL
 * (absent for self-hosted Docker). `.strict()` forbids the illegal
 * desktop-with-publicUrl state (Zod 4 is non-strict by default). Precedent:
 * src/shared/lib/container/runtime-options.ts.
 */
export const agentEnvironmentSchema = z.discriminatedUnion('surface', [
  z.object({ surface: z.literal('desktop') }).strict(),
  z.object({ surface: z.literal('web'), publicUrl: z.string().min(1).optional() }).strict(),
])

export type AgentEnvironment = z.infer<typeof agentEnvironmentSchema>

export function resolveAgentEnvironment(): AgentEnvironment {
  // process.type === 'browser' is the Electron main process - the codebase's
  // existing desktop guard (auth/mode.ts, url-safety.ts, db/index.ts).
  if (process.type === 'browser') return { surface: 'desktop' }
  const publicUrl = process.env.HOST_PUBLIC_URL?.trim()
  return publicUrl ? { surface: 'web', publicUrl } : { surface: 'web' }
}
