/**
 * Main settles the target for every renderer, and the other windows each
 * resolved theirs once and hold it for their own lifetime — the launcher is
 * pre-created at startup and destroyed only at quit, dashboard popouts have
 * already loaded a URL built from the old base. Switching has to tear them down
 * or they keep driving the previous Superagent under identical chrome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyPreferredApiTarget, resolveApiTargetForRenderer } from './api-target'

const { closeQuickDispatchWindow, closeAllDashboardWindows, settings } = vi.hoisted(() => ({
  closeQuickDispatchWindow: vi.fn(),
  closeAllDashboardWindows: vi.fn(),
  settings: { value: {} as Record<string, unknown> },
}))

vi.mock('./quick-dispatch-window', () => ({ closeQuickDispatchWindow }))
vi.mock('./dashboard-window', () => ({ closeAllDashboardWindows }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: () => settings.value,
  mutateSettings: (mutator: (s: Record<string, unknown>) => void) => {
    mutator(settings.value)
    return settings.value
  },
}))

const LOCAL = 'http://localhost:3000'
const CLOUD = 'http://localhost:3000/cloud/KEY123'

beforeEach(() => {
  settings.value = {}
  closeQuickDispatchWindow.mockClear()
  closeAllDashboardWindows.mockClear()
})

describe('resolveApiTargetForRenderer', () => {
  it('serves the local API by default', () => {
    expect(resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual({
      target: 'local',
      baseUrl: LOCAL,
      fallback: null,
    })
  })

  it('serves the keyed proxy prefix when cloud is stored and reachable', () => {
    settings.value.apiTarget = 'cloud'
    expect(resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual({
      target: 'cloud',
      baseUrl: CLOUD,
      fallback: null,
    })
  })

  it('degrades to local, with a reason, when the workspace is gone', () => {
    settings.value.apiTarget = 'cloud'
    expect(resolveApiTargetForRenderer(LOCAL, null)).toEqual({
      target: 'local',
      baseUrl: LOCAL,
      fallback: 'no-workspace',
    })
  })

  it('gives every renderer the same answer', () => {
    settings.value.apiTarget = 'cloud'
    // The main window and the launcher ask separately; they must not diverge.
    expect(resolveApiTargetForRenderer(LOCAL, CLOUD)).toEqual(
      resolveApiTargetForRenderer(LOCAL, CLOUD),
    )
  })
})

describe('applyPreferredApiTarget', () => {
  it('records the choice for subsequent boots', () => {
    applyPreferredApiTarget('cloud')
    expect(resolveApiTargetForRenderer(LOCAL, CLOUD).target).toBe('cloud')
  })

  it('tears down the launcher so it cannot keep driving the old target', () => {
    applyPreferredApiTarget('cloud')
    expect(closeQuickDispatchWindow).toHaveBeenCalled()
  })

  it('tears the launcher down when switching back to local too', () => {
    settings.value.apiTarget = 'cloud'
    applyPreferredApiTarget('local')

    expect(resolveApiTargetForRenderer(LOCAL, CLOUD).target).toBe('local')
    expect(closeQuickDispatchWindow).toHaveBeenCalled()
  })

  it('closes dashboard popouts, which already loaded the old target’s URL', () => {
    // They would otherwise sit there showing the previous deployment's
    // dashboard, and a later request for the same agent/dashboard would focus
    // that stale window instead of opening one on the new target.
    applyPreferredApiTarget('cloud')
    expect(closeAllDashboardWindows).toHaveBeenCalled()
  })

  it('closes them switching back to local too', () => {
    settings.value.apiTarget = 'cloud'
    applyPreferredApiTarget('local')
    expect(closeAllDashboardWindows).toHaveBeenCalled()
  })

  it('refuses to store an unrecognized target', () => {
    applyPreferredApiTarget('somewhere-else')
    expect(settings.value.apiTarget).toBe('local')
  })
})
