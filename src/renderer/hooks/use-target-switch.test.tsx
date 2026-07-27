// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockIsElectron, mockUseCloudWorkspace, mockUsePlatformAuthStatus, mockSwitchTarget } =
  vi.hoisted(() => ({
    mockIsElectron: vi.fn(() => true),
    mockUseCloudWorkspace: vi.fn(),
    mockUsePlatformAuthStatus: vi.fn(),
    mockSwitchTarget: vi.fn(async () => {}),
  }))

vi.mock('@renderer/lib/env', () => ({ isElectron: mockIsElectron }))
vi.mock('@renderer/hooks/use-cloud-workspace', () => ({ useCloudWorkspace: mockUseCloudWorkspace }))
vi.mock('@renderer/hooks/use-platform-auth', () => ({
  usePlatformAuthStatus: mockUsePlatformAuthStatus,
}))

const { mockClear } = vi.hoisted(() => ({ mockClear: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ clear: mockClear }) }))

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mockToastError } }))

vi.mock('@renderer/lib/api-target', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/api-target')>()
  return { ...actual, switchTarget: mockSwitchTarget }
})

import { _resetApiTargetForTest, setActiveTarget } from '@renderer/lib/api-target'
import { useTargetSwitch } from './use-target-switch'

const CONNECTED = { connected: true, orgId: 'org_1' }
const WORKSPACE = { found: true, hasValidToken: true }

beforeEach(() => {
  vi.clearAllMocks()
  mockIsElectron.mockReturnValue(true)
  mockUsePlatformAuthStatus.mockReturnValue({ data: CONNECTED })
  mockUseCloudWorkspace.mockReturnValue({ data: WORKSPACE })
  _resetApiTargetForTest()
})

afterEach(() => {
  _resetApiTargetForTest()
})

describe('availability', () => {
  it('offers the control when a cloud workspace is reachable', () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useTargetSwitch())
    expect(result.current.available).toBe(true)
    expect(result.current.current).toBe('local')
  })

  it('hides the control when there is no cloud workspace', () => {
    setActiveTarget('local', null)
    mockUseCloudWorkspace.mockReturnValue({ data: { found: false, hasValidToken: false } })
    const { result } = renderHook(() => useTargetSwitch())
    // A single-machine user should never see a control with one option.
    expect(result.current.available).toBe(false)
  })

  it('hides the control when the workspace exists but has no live token', () => {
    setActiveTarget('local', null)
    mockUseCloudWorkspace.mockReturnValue({ data: { found: true, hasValidToken: false } })
    const { result } = renderHook(() => useTargetSwitch())
    expect(result.current.available).toBe(false)
  })

  it('hides the control outside Electron', () => {
    setActiveTarget('local', null)
    mockIsElectron.mockReturnValue(false)
    const { result } = renderHook(() => useTargetSwitch())
    expect(result.current.available).toBe(false)
  })

  it('stays available in cloud mode even when the endpoint denies a workspace', () => {
    // The trap: in cloud mode this request goes through the proxy to the
    // deployment, whose getCloudWorkspace self-gates off Electron and answers
    // "no workspace" about itself. Believing it would strand the user in cloud
    // mode with no way back.
    setActiveTarget('cloud', null)
    mockUseCloudWorkspace.mockReturnValue({
      data: { available: false, found: false, hasValidToken: false },
    })

    const { result } = renderHook(() => useTargetSwitch())

    expect(result.current.available).toBe(true)
    expect(result.current.current).toBe('cloud')
  })

  it('does not even ask the deployment while in cloud mode', () => {
    setActiveTarget('cloud', null)
    renderHook(() => useTargetSwitch())
    // First arg is `enabled`.
    expect(mockUseCloudWorkspace).toHaveBeenCalledWith(false, expect.anything())
  })

  it('does not ask before the platform account is connected', () => {
    setActiveTarget('local', null)
    mockUsePlatformAuthStatus.mockReturnValue({ data: { connected: false } })
    renderHook(() => useTargetSwitch())
    expect(mockUseCloudWorkspace.mock.calls[0][0]).toBe(false)
  })
})

describe('switching', () => {
  it('records the new target', async () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockSwitchTarget).toHaveBeenCalledWith('cloud')
  })

  it('drops the previous Superagent’s cached data first', async () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockClear).toHaveBeenCalled()
  })

  it('ignores a switch to the target already in force', async () => {
    setActiveTarget('cloud', null)
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockSwitchTarget).not.toHaveBeenCalled()
    expect(mockClear).not.toHaveBeenCalled()
  })

  it('ignores a second click while the first is still switching', async () => {
    setActiveTarget('local', null)
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })
    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockSwitchTarget).toHaveBeenCalledTimes(1)
  })
})

describe('when the switch fails', () => {
  // The preference write is an IPC round-trip to main and can reject. Nothing
  // has changed when it does, so the window must stay usable — the old shape
  // cleared the cache up front and latched `switching`, which turned one failed
  // IPC call into an empty UI behind a dead control until a manual reload.
  beforeEach(() => {
    setActiveTarget('local', null)
    mockSwitchTarget.mockRejectedValue(new Error('settings are read-only'))
  })

  // clearAllMocks does not drop implementations, so put the happy path back.
  afterEach(() => {
    mockSwitchTarget.mockResolvedValue(undefined)
  })

  it('keeps the current workspace’s data on screen', async () => {
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockClear).not.toHaveBeenCalled()
  })

  it('does not reject into nothing', async () => {
    const { result } = renderHook(() => useTargetSwitch())

    await expect(
      act(async () => {
        await result.current.switchTo('cloud')
      }),
    ).resolves.toBeUndefined()
  })

  it('says so', async () => {
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockToastError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ description: 'settings are read-only' }),
    )
  })

  it('leaves the control usable so the switch can be retried', async () => {
    const { result } = renderHook(() => useTargetSwitch())

    await act(async () => {
      await result.current.switchTo('cloud')
    })
    expect(result.current.switching).toBe(false)

    mockSwitchTarget.mockResolvedValue(undefined)
    await act(async () => {
      await result.current.switchTo('cloud')
    })

    expect(mockSwitchTarget).toHaveBeenCalledTimes(2)
  })
})
