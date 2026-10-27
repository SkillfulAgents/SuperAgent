import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { libsql } from '@shared/lib/db/drivers/libsql'
import type { OpenedDatabase } from '@shared/lib/db/drivers/types'
import { migrateFromBundle } from '@shared/lib/db/open-database'
import { getSettings, loadSettingsStrict, mutateSettings, updateSettings } from '@shared/lib/config/settings'
import { getOrCreateHostToken, hostTokenForStart } from '@shared/lib/container/host-token-store'
import { getTenantId } from '@shared/lib/analytics/tenant-id'
import { expiringMap } from './expiring-map'
import { HostStateConflictError, runWithHostState } from './scope'
import { databaseHostStateStore, type HostStateStore } from './store'

let handle: OpenedDatabase
let store: HostStateStore

beforeEach(async () => {
  handle = await libsql(':memory:').open()
  await migrateFromBundle(handle.db)
  store = databaseHostStateStore(handle.db)
})

afterEach(async () => {
  await handle.close()
})

/** Holds a request open until `release()`, so two requests overlap. */
function gate() {
  let release!: () => void
  const opened = new Promise<void>((resolve) => { release = resolve })
  return { opened, release }
}

describe('settings in a host state scope', () => {
  it('keeps both changes when two overlapping requests change different settings', async () => {
    const a = gate()
    const b = gate()
    const first = runWithHostState(store, async () => {
      await a.opened
      mutateSettings((s) => { s.app.theme = 'dark' })
    })
    const second = runWithHostState(store, async () => {
      await b.opened
      mutateSettings((s) => { s.app.autoSleepTimeoutMinutes = 7 })
    })
    a.release()
    await first
    b.release()
    await second

    await runWithHostState(store, async () => {
      expect(getSettings().app.theme).toBe('dark')
      expect(getSettings().app.autoSleepTimeoutMinutes).toBe(7)
    })
  })

  it('fails a whole-document replace that another request overtook', async () => {
    const replacing = gate()
    const replace = runWithHostState(store, async () => {
      const current = loadSettingsStrict()
      await replacing.opened
      updateSettings({ ...current, app: { ...current.app, theme: 'light' } })
    })
    await runWithHostState(store, async () => {
      mutateSettings((s) => { s.app.autoSleepTimeoutMinutes = 9 })
    })
    replacing.release()

    await expect(replace).rejects.toBeInstanceOf(HostStateConflictError)
    await runWithHostState(store, async () => {
      expect(getSettings().app.autoSleepTimeoutMinutes).toBe(9)
      expect(getSettings().app.theme).not.toBe('light')
    })
  })

  it('runs a mutator once when nothing conflicts', async () => {
    let calls = 0
    await runWithHostState(store, async () => {
      mutateSettings(() => { calls++ })
    })
    expect(calls).toBe(1)
  })
})

describe('host files in a host state scope', () => {
  it('gives overlapping requests one tenant id', async () => {
    const ids = await Promise.all([
      runWithHostState(store, async () => getTenantId()),
      runWithHostState(store, async () => getTenantId()),
    ])
    expect(ids[0]).toBe(ids[1])
  })

  it('starts a container with the token stored first when two requests make one at once', async () => {
    const a = gate()
    const b = gate()
    const first = runWithHostState(store, async () => {
      await a.opened
      return hostTokenForStart('sales-agent')
    })
    const second = runWithHostState(store, async () => {
      await b.opened
      return hostTokenForStart('sales-agent')
    })
    a.release()
    b.release()
    const [tokenA, tokenB] = await Promise.all([first, second])

    expect(tokenA).toBe(tokenB)
    await runWithHostState(store, async () => {
      expect(getOrCreateHostToken('sales-agent')).toBe(tokenA)
    })
  })
})

describe('expiringMap in a host state scope', () => {
  it('lets a later request read and delete what an earlier one stored', async () => {
    const flows = expiringMap<{ codeVerifier: string }>('mcp-oauth', 60_000)
    await runWithHostState(store, () => flows.set('state-123', { codeVerifier: 'verifier-abc' }))

    const found = await runWithHostState(store, async () => {
      const flow = await flows.get('state-123')
      await flows.delete('state-123')
      return flow
    })

    expect(found).toEqual({ codeVerifier: 'verifier-abc' })
    expect(await runWithHostState(store, () => flows.get('state-123'))).toBeUndefined()
  })

  it('hides an expired entry', async () => {
    const flows = expiringMap<string>('mcp-oauth', -1)
    await runWithHostState(store, () => flows.set('state-old', 'stale'))
    expect(await runWithHostState(store, () => flows.get('state-old'))).toBeUndefined()
  })
})
