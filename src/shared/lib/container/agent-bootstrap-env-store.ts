import { z } from 'zod'

// In-memory, single-use stash of the full agent env (keyed by slug) for runtimes
// whose start transport can't carry it; the VM fetches it once via /api/agent-bootstrap.
export const bootstrapEnvSchema = z.record(z.string(), z.string())
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>

const store = new Map<string, BootstrapEnv>()

export function setBootstrapEnv(agentSlug: string, env: BootstrapEnv): void {
  store.set(agentSlug, bootstrapEnvSchema.parse(env))
}

// Returns the stashed env and deletes it (single-use). Null if absent/consumed.
export function consumeBootstrapEnv(agentSlug: string): BootstrapEnv | null {
  const env = store.get(agentSlug)
  if (!env) return null
  store.delete(agentSlug)
  return env
}

export function clearBootstrapEnv(agentSlug: string): void {
  store.delete(agentSlug)
}

export function resetBootstrapEnvStoreForTests(): void {
  store.clear()
}
