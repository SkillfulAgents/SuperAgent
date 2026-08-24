import { describe, expect, it } from 'vitest'

import { decideWizardAutoOpen } from './boot-gate'

describe('decideWizardAutoOpen', () => {
  it('releases immediately for a non-admin in auth mode', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: undefined,
        globalSettings: undefined,
        isAuthMode: true,
        isAdmin: false,
      }),
    ).toBe('release')
  })

  it('waits for user settings on a local boot', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: undefined,
        globalSettings: undefined,
        isAuthMode: false,
        isAdmin: false,
      }),
    ).toBe('wait')
  })

  it('releases once the user has already completed setup', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: { setupCompleted: true },
        globalSettings: undefined,
        isAuthMode: true,
        isAdmin: true,
      }),
    ).toBe('release')
  })

  it('opens the full wizard on a local first boot', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: { setupCompleted: false },
        globalSettings: undefined,
        isAuthMode: false,
        isAdmin: false,
      }),
    ).toBe('open-full')
  })

  it('waits for global settings before an admin first-boot decision', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: { setupCompleted: false },
        globalSettings: undefined,
        isAuthMode: true,
        isAdmin: true,
      }),
    ).toBe('wait')
  })

  it('opens the full wizard for an admin when global setup is incomplete', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: { setupCompleted: false },
        globalSettings: { setupCompleted: false },
        isAuthMode: true,
        isAdmin: true,
      }),
    ).toBe('open-full')
  })

  it('opens the agent-only wizard when global setup is already done', () => {
    expect(
      decideWizardAutoOpen({
        userSettings: { setupCompleted: false },
        globalSettings: { setupCompleted: true },
        isAuthMode: true,
        isAdmin: true,
      }),
    ).toBe('open-agent-only')
  })
})
