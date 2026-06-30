import { z } from 'zod'

// In-memory, single-use stash of the full agent env (keyed by slug) for runtimes
// whose start transport can't carry it; the VM fetches it once via /api/agent-bootstrap.
export const bootstrapEnvSchema = z.record(z.string(), z.string())
export type BootstrapEnv = z.infer<typeof bootstrapEnvSchema>

const store = new Map<string, BootstrapEnv>()

// TEMP debug instrumentation (debug/microvm-bootstrap-env-logging). Logs the
// lifecycle of the in-memory bootstrap env stash WITHOUT printing values, so we
// can align set/read/clear against the MicroVM boot fetch timeline. Remove before
// merge.
function bootstrapDebug(event: string, agentSlug: string, extra?: Record<string, unknown>): void {
  try {
    const payload = {
      ts: new Date().toISOString(),
      event,
      agentSlug,
      pid: process.pid,
      keys: Array.from(store.keys()),
      ...extra,
    }
    console.log(`[bootstrap-debug] ${JSON.stringify(payload)}`)
  } catch {
    // never let logging break the store
  }
}

export function setBootstrapEnv(agentSlug: string, env: BootstrapEnv): void {
  store.set(agentSlug, bootstrapEnvSchema.parse(env))
  bootstrapDebug('set', agentSlug, { envKeyCount: Object.keys(env).length })
}

// Returns the stashed env WITHOUT removing it. Re-fetchable so a VM whose boot
// fetch is retried (lost response, re-boot before resume) still gets its env;
// the entry is dropped on agent teardown via clearBootstrapEnv. Null if cleared.
export function readBootstrapEnv(agentSlug: string): BootstrapEnv | null {
  const env = store.get(agentSlug) ?? null
  bootstrapDebug(env ? 'read-hit' : 'read-miss', agentSlug, {
    envKeyCount: env ? Object.keys(env).length : 0,
  })
  return env
}

export function clearBootstrapEnv(agentSlug: string): void {
  const existed = store.has(agentSlug)
  store.delete(agentSlug)
  // Capture WHO cleared it (which code path), since a premature clear in the boot
  // window would explain a 404 even though set ran.
  const caller = new Error().stack?.split('\n').slice(2, 6).join(' <- ').trim()
  bootstrapDebug('clear', agentSlug, { existed, caller })
}

export function resetBootstrapEnvStoreForTests(): void {
  store.clear()
}
