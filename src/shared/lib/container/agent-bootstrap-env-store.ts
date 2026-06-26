import { z } from 'zod'

// In-memory, single-use stash of the full agent env (keyed by slug) for runtimes
// whose start transport can't carry it; the VM fetches it once via /api/agent-bootstrap.
export const bootstrapEnvSchema = z.record(z.string(), z.string())
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>

const store = new Map<string, BootstrapEnv>()

export function setBootstrapEnv(agentSlug: string, env: BootstrapEnv): void {
  store.set(agentSlug, bootstrapEnvSchema.parse(env))
}

// Returns the stashed env WITHOUT removing it. Re-fetchable so a VM whose boot
// fetch is retried (lost response, re-boot before resume) still gets its env;
// the entry is dropped on agent teardown via clearBootstrapEnv. Null if cleared.
export function readBootstrapEnv(agentSlug: string): BootstrapEnv | null {
  return store.get(agentSlug) ?? null
}

export function clearBootstrapEnv(agentSlug: string): void {
  store.delete(agentSlug)
}

export function resetBootstrapEnvStoreForTests(): void {
  store.clear()
}
