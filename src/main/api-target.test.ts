/**
 * Main settles the target for every renderer, and the other windows each
 * resolved theirs once and hold it for their own lifetime — the launcher is
 * pre-created at startup and destroyed only at quit, dashboard popouts have
 * already loaded a URL built from the old base. Switching has to tear them down
 * or they keep driving the previous Superagent under identical chrome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyPreferredApiTarget, resolveApiTargetForRenderer } from './api-target'

const {
  closeQuickDispatchWindow,
  closeAllDashboardWindows,
  startCloudBootPrefetch,
  refreshTrayMenu,
  refreshAppMenu,
  settings,
} = vi.hoisted(() => ({
  closeQuickDispatchWindow: vi.fn(),
  closeAllDashboardWindows: vi.fn(),
  startCloudBootPrefetch: vi.fn(async () => {}),
  refreshTrayMenu: vi.fn(),
  refreshAppMenu: vi.fn(),
  settings: { value: {} as Record<string, unknown>, failWrite: false },
}))

vi.mock('./quick-dispatch-window', () => ({ closeQuickDispatchWindow }))
vi.mock('./dashboard-window', () => ({ closeAllDashboardWindows }))
vi.mock('./tray', () => ({ refreshTrayMenu }))
vi.mock('./app-menu', () => ({ refreshAppMenu }))
vi.mock('@shared/lib/services/cloud-boot-prefetch', () => ({ startCloudBootPrefetch }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => settings.value,
  mutateSettings: async (mutator: (s: Record<string, unknown>) => void) => {
    if (settings.failWrite) throw new Error('database is locked')
    mutator(settings.value)
    return settings.value
  },
}))

const LOCAL = 'http://localhost:3000'
const CLOUD_BASE = 'http://localhost:3000/cloud/KEY123'
const DEPLOYMENT = 'https://acme.gamut.example'
const CLOUD = { baseUrl: CLOUD_BASE, deploymentUrl: DEPLOYMENT }

beforeEach(() => {
  settings.value = {}
  settings.failWrite = false
  closeQuickDispatchWindow.mockClear()
  closeAllDashboardWindows.mockClear()
  startCloudBootPrefetch.mockClear()
  refreshTrayMenu.mockClear()
  refreshAppMenu.mockClear()
})

describe('resolveApiTargetForRenderer', () => {
  it('serves the local API by default', async () => {
    expect(await resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual({
      target: 'local',
      baseUrl: LOCAL,
      deploymentUrl: null,
      fallback: null,
    })
  })

  it('serves the keyed proxy prefix when cloud is stored and reachable', async () => {
    settings.value.apiTarget = 'cloud'
    expect(await resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual({
      target: 'cloud',
      baseUrl: CLOUD_BASE,
      deploymentUrl: DEPLOYMENT,
      fallback: null,
    })
  })

  it('degrades to local, with a reason, when the workspace is gone', async () => {
    settings.value.apiTarget = 'cloud'
    expect(await resolveApiTargetForRenderer(LOCAL, null)).toEqual({
      target: 'local',
      baseUrl: LOCAL,
      deploymentUrl: null,
      fallback: 'no-workspace',
    })
  })

  it('gives every renderer the same answer', async () => {
    settings.value.apiTarget = 'cloud'
    // The main window and the launcher ask separately; they must not diverge.
    expect(await resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual(
      await resolveApiTargetForRenderer(LOCAL, CLOUD),
    )
  })
})

describe('applyPreferredApiTarget', () => {
  it('records the choice for subsequent boots', async () => {
    await applyPreferredApiTarget('cloud')
    expect((await resolveApiTargetForRenderer(LOCAL, CLOUD)).target).toBe('cloud')
  })

  it('tears down the launcher so it cannot keep driving the old target', async () => {
    await applyPreferredApiTarget('cloud')
    expect(closeQuickDispatchWindow).toHaveBeenCalled()
  })

  it('tears the launcher down when switching back to local too', async () => {
    settings.value.apiTarget = 'cloud'
    await applyPreferredApiTarget('local')

    expect((await resolveApiTargetForRenderer(LOCAL, CLOUD)).target).toBe('local')
    expect(closeQuickDispatchWindow).toHaveBeenCalled()
  })

  it('closes dashboard popouts, which already loaded the old target’s URL', async () => {
    // They would otherwise sit there showing the previous deployment's
    // dashboard, and a later request for the same agent/dashboard would focus
    // that stale window instead of opening one on the new target.
    await applyPreferredApiTarget('cloud')
    expect(closeAllDashboardWindows).toHaveBeenCalled()
  })

  it('closes them switching back to local too', async () => {
    settings.value.apiTarget = 'cloud'
    await applyPreferredApiTarget('local')
    expect(closeAllDashboardWindows).toHaveBeenCalled()
  })

  it('refuses to store an unrecognized target', async () => {
    await applyPreferredApiTarget('somewhere-else')
    expect(settings.value.apiTarget).toBe('local')
  })

  it('rebuilds the tray and app menu now, instead of waiting out their poll', async () => {
    // Both list agents from the effective target; on their 30s interval the
    // previous Superagent's agents would sit in the menus for up to that long.
    await applyPreferredApiTarget('cloud')
    expect(refreshTrayMenu).toHaveBeenCalled()
    expect(refreshAppMenu).toHaveBeenCalled()
  })

  it('rebuilds them switching back to local too', async () => {
    settings.value.apiTarget = 'cloud'
    await applyPreferredApiTarget('local')
    expect(refreshTrayMenu).toHaveBeenCalled()
    expect(refreshAppMenu).toHaveBeenCalled()
  })

  it('starts the workspace round trips here, before the reload', async () => {
    // This is the earliest anyone knows a cloud boot is coming. Waiting for the
    // renderer to mount and ask would put the reload and the network in series.
    await applyPreferredApiTarget('cloud')
    expect(startCloudBootPrefetch).toHaveBeenCalled()
  })

  it('does not call out to a workspace when switching to this computer', async () => {
    settings.value.apiTarget = 'cloud'
    await applyPreferredApiTarget('local')
    expect(startCloudBootPrefetch).not.toHaveBeenCalled()
  })

  it('changes nothing when the choice cannot be stored, so the switch can be retried', async () => {
    settings.failWrite = true
    await expect(applyPreferredApiTarget('cloud')).rejects.toThrow('database is locked')

    expect(closeQuickDispatchWindow).not.toHaveBeenCalled()
    expect(closeAllDashboardWindows).not.toHaveBeenCalled()
    expect(startCloudBootPrefetch).not.toHaveBeenCalled()
    expect(refreshTrayMenu).not.toHaveBeenCalled()
  })

  it('does not call out for a target it refused to store', async () => {
    await applyPreferredApiTarget('somewhere-else')
    expect(startCloudBootPrefetch).not.toHaveBeenCalled()
  })
})
