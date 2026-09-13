/**
 * Test helper: present a container-manager-shaped mock as a `containerHost`.
 *
 * Tests written against the old container manager mock its methods with the
 * agent slug as the first argument (`ensureRunning('agent')`, `getCachedInfo`,
 * `getClient`, …). The host hands out one runtime per agent with the slug
 * bound, so a runtime method has no slug parameter. This adapter gives each
 * runtime methods that call the manager-shaped mock with the slug prepended,
 * so existing `toHaveBeenCalledWith('agent', …)` assertions keep holding, and
 * forwards the host-level methods as they are.
 *
 * Usage inside a `vi.mock` factory:
 *
 *   vi.mock('@shared/lib/container/container-host', async () => {
 *     const { hostFromManagerMock } = await import('@shared/lib/agent-actor/testing/host-from-manager-mock')
 *     return { containerHost: hostFromManagerMock({ ensureRunning: mockEnsureRunning, getClient: () => client }) }
 *   })
 *
 * Only methods present on the mock are forwarded; anything else is undefined,
 * exactly as it was on the partial manager mock.
 */

type AnyFn = (...args: unknown[]) => unknown
type ManagerShapedMock = Record<string, unknown>

/** Runtime methods that took the slug as their first argument on the manager. */
const PER_AGENT_METHODS = [
  'getClient',
  'ensureRunning',
  'getCachedInfo',
  'updateCachedStatus',
  'markAsStopped',
  'stopContainer',
  'restartContainer',
  'syncAgentStatus',
  'getHealthWarnings',
  'getContainerStartTime',
  'keepAlive',
  'getLastKeepAlive',
  'handleUnexpectedDeath',
] as const

/** Runtime methods whose manager counterpart had a different name. */
const RENAMED_PER_AGENT: Record<string, string> = {
  dispose: 'removeClient',
}

/** Host-level methods, unchanged in name and signature. */
const HOST_METHODS = [
  'getRunningAgentIds',
  'hasRunningAgents',
  'getReadiness',
  'resetReadiness',
  'markRuntimeUnavailable',
  'updateStartProgress',
  'ensureImageReady',
  'initializeAgents',
  'syncAllStatuses',
  'startStatusSync',
  'stopStatusSync',
  'startHealthMonitor',
  'stopHealthMonitor',
  'stopAll',
  'stopAllSync',
  'workspaceHostPath',
] as const

/** Host-level methods whose manager counterpart had a different name. */
const RENAMED_HOST: Record<string, string> = {
  dropRuntime: 'removeClient',
  clearRuntimes: 'clearClients',
}

export function hostFromManagerMock(manager: ManagerShapedMock): Record<string, unknown> {
  const runtimes = new Map<string, Record<string, unknown>>()

  const runtimeFor = (slug: string): Record<string, unknown> => {
    let runtime = runtimes.get(slug)
    if (runtime) return runtime
    runtime = { slug, hasClient: () => true, isStopping: () => false, isStarting: () => false }
    for (const name of PER_AGENT_METHODS) {
      const fn = manager[name]
      if (typeof fn === 'function') {
        runtime[name] = (...args: unknown[]) => (fn as AnyFn).call(manager, slug, ...args)
      }
    }
    for (const [runtimeName, managerName] of Object.entries(RENAMED_PER_AGENT)) {
      const fn = manager[managerName]
      if (typeof fn === 'function') {
        runtime[runtimeName] = (...args: unknown[]) => (fn as AnyFn).call(manager, slug, ...args)
      }
    }
    runtimes.set(slug, runtime)
    return runtime
  }

  const host: Record<string, unknown> = {
    runtime: runtimeFor,
    peekRuntime: (slug: string) => runtimes.get(slug),
  }
  for (const name of HOST_METHODS) {
    const fn = manager[name]
    if (typeof fn === 'function') host[name] = (...args: unknown[]) => (fn as AnyFn).call(manager, ...args)
  }
  for (const [hostName, managerName] of Object.entries(RENAMED_HOST)) {
    const fn = manager[managerName]
    if (typeof fn === 'function') host[hostName] = (...args: unknown[]) => (fn as AnyFn).call(manager, ...args)
  }
  // `onBeforeContainerStop` is a property the app assigns; share it with the mock.
  Object.defineProperty(host, 'onBeforeContainerStop', {
    get: () => manager.onBeforeContainerStop,
    set: (value) => {
      manager.onBeforeContainerStop = value
    },
    enumerable: true,
  })
  return host
}
