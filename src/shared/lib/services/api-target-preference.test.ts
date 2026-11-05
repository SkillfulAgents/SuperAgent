/**
 * The target preference lives in main-owned settings, not renderer storage, so
 * that every window (main app and quick-dispatch launcher alike) reads the same
 * answer about which machine executes work.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { readPreferredApiTarget, writePreferredApiTarget } from './api-target-preference'

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }))

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async () => state.settings,
  mutateSettings: async (mutator: (settings: Record<string, unknown>) => void) => {
    mutator(state.settings)
    return state.settings
  },
}))

beforeEach(() => {
  state.settings = {}
})

describe('readPreferredApiTarget', () => {
  it('defaults to local when nothing was ever chosen', async () => {
    expect(await readPreferredApiTarget()).toBe('local')
  })

  it('remembers a cloud choice', async () => {
    state.settings.apiTarget = 'cloud'
    expect(await readPreferredApiTarget()).toBe('cloud')
  })

  it('reads a corrupt stored value as local', async () => {
    state.settings.apiTarget = 'production'
    expect(await readPreferredApiTarget()).toBe('local')
  })
})

describe('writePreferredApiTarget', () => {
  it('persists a choice for subsequent boots', async () => {
    await writePreferredApiTarget('cloud')
    expect(state.settings.apiTarget).toBe('cloud')
    expect(await readPreferredApiTarget()).toBe('cloud')
  })

  it('persists a switch back to local', async () => {
    state.settings.apiTarget = 'cloud'
    await writePreferredApiTarget('local')
    expect(await readPreferredApiTarget()).toBe('local')
  })

  it('leaves the rest of settings intact', async () => {
    // It writes through mutateSettings (fresh-read + atomic write), so a
    // concurrent settings change cannot be lost-updated by a target switch.
    state.settings.cloudWorkspace = { token: 'keep-me' }
    await writePreferredApiTarget('cloud')
    expect(state.settings.cloudWorkspace).toEqual({ token: 'keep-me' })
  })
})
