// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { navigate, openSettings, createUntitledAgent, switchTo, targetSwitch } = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSettings: vi.fn(),
  createUntitledAgent: vi.fn(),
  switchTo: vi.fn(async (_target: 'local' | 'cloud') => true),
  targetSwitch: { ready: true },
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))
vi.mock('../context/dialog-context', () => ({ useDialogs: () => ({ openSettings }) }))
vi.mock('../hooks/use-create-untitled-agent', () => ({ useCreateUntitledAgent: () => ({ createUntitledAgent }) }))
vi.mock('../hooks/use-target-switch', () => ({
  useTargetSwitch: () => ({ switchTo, ready: targetSwitch.ready }),
}))

import { MenuCommandHandler } from './menu-command-handler'

type Command =
  | { channel: 'navigate-to-agent'; agentSlug: string; sessionId?: string | null }
  | { channel: 'switch-target'; target: 'local' | 'cloud' }

function installElectronApi(queued: Command[]) {
  let liveSwitch: ((target: 'local' | 'cloud') => void) | null = null
  const flushPendingMenuCommands = vi.fn(async () => queued)
  const declineTargetSwitch = vi.fn()
  window.electronAPI = {
    flushPendingMenuCommands,
    declineTargetSwitch,
    onNavigateToAgent: () => () => {},
    onOpenSettings: () => () => {},
    onOpenCreateAgent: () => () => {},
    onSwitchTarget: (callback: (target: 'local' | 'cloud') => void) => {
      liveSwitch = callback
      return () => {
        liveSwitch = null
      }
    },
  } as unknown as Window['electronAPI']
  return {
    flushPendingMenuCommands,
    declineTargetSwitch,
    sendSwitch(target: 'local' | 'cloud') {
      liveSwitch?.(target)
    },
  }
}

describe('MenuCommandHandler: switch-target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    targetSwitch.ready = true
  })

  afterEach(() => {
    delete (window as { electronAPI?: unknown }).electronAPI
  })

  it('holds a switch replayed on mount until the platform status has loaded', async () => {
    targetSwitch.ready = false
    const api = installElectronApi([{ channel: 'switch-target', target: 'cloud' }])
    const { rerender } = render(<MenuCommandHandler />)
    await waitFor(() => expect(api.flushPendingMenuCommands).toHaveBeenCalled())
    await act(async () => {})
    expect(switchTo).not.toHaveBeenCalled()

    targetSwitch.ready = true
    rerender(<MenuCommandHandler />)
    rerender(<MenuCommandHandler />)
    expect(switchTo).toHaveBeenCalledTimes(1)
    expect(switchTo).toHaveBeenCalledWith('cloud')
  })

  it('switches on a live request through the Local/Cloud path', async () => {
    const api = installElectronApi([])
    render(<MenuCommandHandler />)
    await waitFor(() => expect(api.flushPendingMenuCommands).toHaveBeenCalled())

    act(() => api.sendSwitch('local'))
    expect(switchTo).toHaveBeenCalledWith('local')
    await act(async () => {})
    expect(api.declineTargetSwitch).not.toHaveBeenCalled()
  })

  it('tells main when the switch did not happen', async () => {
    switchTo.mockResolvedValueOnce(false)
    const api = installElectronApi([])
    render(<MenuCommandHandler />)
    await waitFor(() => expect(api.flushPendingMenuCommands).toHaveBeenCalled())

    act(() => api.sendSwitch('cloud'))
    await waitFor(() => expect(api.declineTargetSwitch).toHaveBeenCalledTimes(1))
  })

  it('opens the session a replayed navigation names', async () => {
    installElectronApi([{ channel: 'navigate-to-agent', agentSlug: 'finance', sessionId: 's1' }])
    render(<MenuCommandHandler />)

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: 'finance', sessionId: 's1' },
      }),
    )
  })
})
