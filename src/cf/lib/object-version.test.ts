import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DurableObjectNamespace, DurableObjectState } from 'cloudflare:workers'
import { reachCurrentCode, restartIfOlder, type VersionedObject } from './object-version'

const OLD = '2026-11-06T18:55:00.000Z'
const NEW = '2026-11-06T19:01:00.000Z'

/** One named object across restarts: each restart starts an instance on the latest deployed code. */
function deployedObject(running: string) {
  const state = { running, deployed: NEW, calls: [] as string[] }
  const instance = () => ({
    checkVersion: async (caller: string) => {
      state.calls.push(`checkVersion on ${state.running}`)
      const older = Date.parse(caller) > Date.parse(state.running)
      if (older) state.running = state.deployed
      return older
    },
    fetch: async () => {
      state.calls.push(`fetch on ${state.running}`)
      return new Response(state.running)
    },
  })
  const namespace = { getByName: () => instance() } as unknown as DurableObjectNamespace<VersionedObject & { fetch(): Promise<Response> }>
  return { state, namespace }
}

describe('reachCurrentCode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('restarts an object on older code before the first call reaches it', async () => {
    const { state, namespace } = deployedObject(OLD)

    await reachCurrentCode(namespace, 'sales-agent', NEW)
    const object = namespace.getByName('sales-agent') as unknown as { fetch(): Promise<Response> }

    expect(await (await object.fetch()).text()).toBe(NEW)
    expect(state.calls).toEqual([`checkVersion on ${OLD}`, `checkVersion on ${NEW}`, `fetch on ${NEW}`])
  })

  it('checks each object once per isolate and version', async () => {
    const { state, namespace } = deployedObject(NEW)

    await reachCurrentCode(namespace, 'support-agent', NEW)
    await reachCurrentCode(namespace, 'support-agent', NEW)

    expect(state.calls.filter((call) => call.startsWith('checkVersion'))).toHaveLength(1)
  })

  it('lets the call go on when the object has no checkVersion yet, and checks again next time', async () => {
    let attempts = 0
    const namespace = {
      getByName: () => ({
        checkVersion: async () => {
          attempts++
          throw new TypeError('The RPC receiver does not implement the method "checkVersion".')
        },
      }),
    } as unknown as DurableObjectNamespace<VersionedObject>

    await expect(reachCurrentCode(namespace, 'ops-agent', NEW)).resolves.toBeUndefined()
    await reachCurrentCode(namespace, 'ops-agent', NEW)

    expect(attempts).toBe(2)
  })
})

describe('restartIfOlder', () => {
  it('restarts only for a caller on newer code, after answering', () => {
    vi.useFakeTimers()
    try {
      const abort = vi.fn()
      const ctx = { id: { name: 'sales-agent', toString: () => 'sales-agent' }, abort } as unknown as DurableObjectState
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(restartIfOlder(ctx, { id: 'v1', timestamp: NEW }, OLD)).toBe(false)
      expect(restartIfOlder(ctx, { id: 'v1', timestamp: OLD }, NEW)).toBe(true)
      expect(abort).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(abort).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
