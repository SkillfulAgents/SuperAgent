import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AgentComputerUse } from './agent-permissions'

const mockGetSettings = vi.fn()
const mockMutateSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: async (...args: unknown[]) => mockGetSettings(...args),
  mutateSettings: async (mutator: (s: Record<string, unknown>) => void) => {
    const s = structuredClone(mockGetSettings() ?? {})
    mutator(s)
    mockMutateSettings(s)
    mockGetSettings.mockReturnValue(s)
    return s
  },
}))

describe('AgentComputerUse session grant', () => {
  let store: AgentComputerUse

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({})
    store = new AgentComputerUse('agent-1')
  })

  it('lets the session list and use any app without asking', async () => {
    store.grantSession('s1')
    expect(await store.check('list_apps_windows', undefined, 's1')).toBe('granted')
    expect(await store.check('use_application', 'Safari', 's1')).toBe('granted')
    expect(await store.check('use_application', 'Notes', 's1')).toBe('granted')
    expect(await store.check('use_application', undefined, 's1')).toBe('granted')
  })

  it('still asks before a host shell script', async () => {
    store.grantSession('s1')
    expect(await store.check('use_host_shell', undefined, 's1')).toBe('prompt_needed')
  })

  it('is the session’s alone', async () => {
    store.grantSession('s1')
    expect(await store.check('use_application', 'Safari', 's2')).toBe('prompt_needed')
    expect(await store.check('use_application', 'Safari')).toBe('prompt_needed')
  })

  it('is never persisted', async () => {
    store.grantSession('s1')
    expect(mockMutateSettings).not.toHaveBeenCalled()
    expect(await new AgentComputerUse('agent-1').check('use_application', 'Safari', 's1')).toBe('prompt_needed')
  })

  it('ends with revokeSession, leaving other grants', async () => {
    store.grantSession('s1')
    await store.grant('use_application', 'timed', 'Notes')
    store.revokeSession('s1')
    expect(await store.check('use_application', 'Safari', 's1')).toBe('prompt_needed')
    expect(await store.check('use_application', 'Notes', 's1')).toBe('granted')
  })

  it('ends with revokeAll', async () => {
    store.grantSession('s1')
    await store.revokeAll()
    expect(await store.check('use_application', 'Safari', 's1')).toBe('prompt_needed')
  })
})

describe('AgentComputerUse any-app grant', () => {
  let store: AgentComputerUse

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({})
    store = new AgentComputerUse('agent-1')
  })

  it.each(['timed', 'always'] as const)('a %s grant covers every app, the read-only level and a call whose app is unknown, but no shell script', async (grantType) => {
    await store.grant('use_any_application', grantType)
    expect(await store.check('use_application', 'Notes')).toBe('granted')
    expect(await store.check('use_application', 'Safari')).toBe('granted')
    // A click at a screen point the window list could not place.
    expect(await store.check('use_application', undefined)).toBe('granted')
    expect(await store.check('list_apps_windows')).toBe('granted')
    expect(await store.check('use_host_shell')).toBe('prompt_needed')
  })

  it('saves the always grant in settings, and reads one saved there', async () => {
    await store.grant('use_any_application', 'always')
    expect(mockMutateSettings).toHaveBeenLastCalledWith({
      computerUse: { agentPermissions: { 'agent-1': { grants: [{ level: 'use_any_application', grantType: 'always' }] } } },
    })
    // Another actor (after a restart, say) reads it back.
    expect(await new AgentComputerUse('agent-1').check('use_application', undefined)).toBe('granted')
    expect(await new AgentComputerUse('agent-2').check('use_application', 'Notes')).toBe('prompt_needed')
  })

  it('keeps a timed grant in memory only, until it expires', async () => {
    vi.useFakeTimers()
    try {
      await store.grant('use_any_application', 'timed')
      expect(mockMutateSettings).not.toHaveBeenCalled()
      vi.advanceTimersByTime(14 * 60_000)
      expect(await store.check('use_application', undefined)).toBe('granted')
      vi.advanceTimersByTime(2 * 60_000)
      expect(await store.check('use_application', undefined)).toBe('prompt_needed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends with its own revoke, leaving a one-app grant', async () => {
    await store.grant('use_application', 'always', 'Notes')
    await store.grant('use_any_application', 'always')
    await store.revoke('use_any_application')
    expect(await store.check('use_application', 'Safari')).toBe('prompt_needed')
    expect(await store.check('use_application', 'Notes')).toBe('granted')
  })

  it('writes settings on a revoke only when they hold the grant', async () => {
    await store.grant('use_any_application', 'timed')
    await store.revoke('use_any_application')
    await store.revoke('use_application', 'Notes')
    expect(mockMutateSettings).not.toHaveBeenCalled()
    expect(await store.check('use_application', 'Notes')).toBe('prompt_needed')

    await store.grant('use_any_application', 'always')
    mockMutateSettings.mockClear()
    await store.revoke('use_any_application')
    expect(mockMutateSettings).toHaveBeenCalledTimes(1)
  })

  it('is not ended by revoking one app', async () => {
    await store.grant('use_any_application', 'timed')
    await store.revoke('use_application', 'Notes')
    expect(await store.check('use_application', 'Notes')).toBe('granted')
  })

  it('still grants nothing lasting for an app grant that names no app', async () => {
    await store.grant('use_application', 'always')
    expect(await store.check('use_application', undefined)).toBe('prompt_needed')
    expect(await store.check('use_application', 'Notes')).toBe('prompt_needed')
  })
})

describe('AgentComputerUse app grants on Windows', () => {
  const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    vi.clearAllMocks()
    mockGetSettings.mockReturnValue({})
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  })
  afterEach(() => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) })

  it('covers the app however it is spelled: with or without .exe, in any case', async () => {
    const store = new AgentComputerUse('agent-1')
    await store.grant('use_application', 'always', 'notepad')
    expect(await store.check('use_application', 'Notepad.exe')).toBe('granted')
    expect(await store.check('use_application', 'NOTEPAD')).toBe('granted')
    expect(await store.check('use_application', 'notepad++.exe')).toBe('prompt_needed')
  })

  it('does not count a respelling as a new active app', () => {
    const store = new AgentComputerUse('agent-1')
    expect(store.setActiveApp('s1', 'notepad')).toBe(true)
    expect(store.setActiveApp('s1', 'Notepad.exe')).toBe(false)
    expect(store.setActiveApp('s1', 'CalculatorApp.exe')).toBe(true)
  })
})
