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
