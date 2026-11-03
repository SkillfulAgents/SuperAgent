import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AgentComputerUse } from './agent-permissions'

const mockGetSettings = vi.fn()
const mockMutateSettings = vi.fn()

vi.mock('@shared/lib/config/settings', () => ({
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  mutateSettings: (mutator: (s: Record<string, unknown>) => void) => {
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

  it('lets the session list and use any app without asking', () => {
    store.grantSession('s1')
    expect(store.check('list_apps_windows', undefined, 's1')).toBe('granted')
    expect(store.check('use_application', 'Safari', 's1')).toBe('granted')
    expect(store.check('use_application', 'Notes', 's1')).toBe('granted')
    expect(store.check('use_application', undefined, 's1')).toBe('granted')
  })

  it('still asks before a host shell script', () => {
    store.grantSession('s1')
    expect(store.check('use_host_shell', undefined, 's1')).toBe('prompt_needed')
  })

  it('is the session’s alone', () => {
    store.grantSession('s1')
    expect(store.check('use_application', 'Safari', 's2')).toBe('prompt_needed')
    expect(store.check('use_application', 'Safari')).toBe('prompt_needed')
  })

  it('is never persisted', () => {
    store.grantSession('s1')
    expect(mockMutateSettings).not.toHaveBeenCalled()
    expect(new AgentComputerUse('agent-1').check('use_application', 'Safari', 's1')).toBe('prompt_needed')
  })

  it('ends with revokeSession, leaving other grants', () => {
    store.grantSession('s1')
    store.grant('use_application', 'timed', 'Notes')
    store.revokeSession('s1')
    expect(store.check('use_application', 'Safari', 's1')).toBe('prompt_needed')
    expect(store.check('use_application', 'Notes', 's1')).toBe('granted')
  })

  it('ends with revokeAll', () => {
    store.grantSession('s1')
    store.revokeAll()
    expect(store.check('use_application', 'Safari', 's1')).toBe('prompt_needed')
  })
})
