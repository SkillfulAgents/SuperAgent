/**
 * SuperAgent in an agent's own object (cloudflare-agent.ts): the shared boot (boot-core.ts), then
 * the agent's actor and its idle check. It loads neither the API nor the background services,
 * which run in the Worker and in the org's task manager object (boot.ts).
 */
import { getSettings } from '@shared/lib/config/settings'
import { agentRegistry, containerHost } from '@shared/lib/agent-actor'
import type { AgentSlug } from '@shared/lib/agent-actor/types'
// eslint-disable-next-line local-rules/no-agent-internals-outside-actor -- the agent's object schedules its idle check from the same timeout the alarm reads
import { autoSleepTimeoutMsFrom } from '@shared/lib/container/container-runtime'
import { IDLE_ALARM_RETRY_MS } from '@shared/lib/container/idle-alarm'
import { bootCore, prepareIsolate } from './boot-core'
import { ensureOrgPrepared } from './cloudflare-task-manager'
import { runActorOp, type ActorOutcome } from './cloudflare-agent-actor'
import type { Env } from './index'

let booted: Promise<void> | undefined
/** Boots SuperAgent for an agent's object in this isolate once; a failed boot is tried again by the next call. */
export function boot(env: Env): Promise<void> {
  booted ??= bootCore(env)
    // No service runs here, so no readiness check does: readiness comes from the runners' setup, as registerBackgroundWork sets it in the Worker.
    .then(() => containerHost.deriveReadiness())
    .then(() => ensureOrgPrepared(env))
    .then(prepareIsolate)
    .catch((error: unknown) => {
      booted = undefined
      throw error
    })
  return booted
}

/** An op on the agent's actor, in the agent's own object. */
export function runAgentActorOp(slug: AgentSlug, path: string, args: unknown[]): Promise<ActorOutcome> {
  return runActorOp(agentRegistry.get(slug), path, args)
}

/** Sets the agent's cached container status from its container, which outlives the object's memory. */
export async function syncAgentStatus(slug: AgentSlug): Promise<void> {
  await containerHost.runtime(slug).syncAgentStatus()
}

/**
 * The agent's idle check, in its own object: SuperAgent's idle decision puts the agent to sleep
 * if it has been idle past the auto-sleep timeout. Returns when to check again, or null when
 * auto-sleep is off. The object's alarm outlives this isolate, whose process timer does not.
 */
export async function checkIdle(slug: AgentSlug): Promise<number | null> {
  const runtime = containerHost.runtime(slug)
  await runtime.idleAlarm.fire()
  const timeoutMs = autoSleepTimeoutMsFrom(await getSettings())
  if (timeoutMs <= 0) return null
  const now = Date.now()
  const idleSince = runtime.idleSince()
  // Busy: a full window from now. Quiet: the rest of the window, or a retry if a sleep did not complete.
  if (idleSince === null) return now + timeoutMs
  return Math.max(idleSince + timeoutMs, now + IDLE_ALARM_RETRY_MS)
}
