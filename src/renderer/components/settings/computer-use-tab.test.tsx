// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComputerUseTab } from './computer-use-tab'

const useSettingsMock = vi.fn()
const useAgentsMock = vi.fn()
const mutateMock = vi.fn()
const getPlatformMock = vi.fn()

vi.mock('@renderer/hooks/use-settings', () => ({
  useSettings: () => useSettingsMock(),
  useUpdateSettings: () => ({ mutate: mutateMock }),
}))

vi.mock('@renderer/hooks/use-agents', () => ({
  useAgents: () => useAgentsMock(),
}))

vi.mock('@renderer/lib/env', () => ({
  getPlatform: () => getPlatformMock(),
}))

const grants = {
  'designer-agent': {
    grants: [
      {
        level: 'list_apps_windows' as const,
        grantType: 'always' as const,
      },
      {
        level: 'use_application' as const,
        appName: 'Figma',
        grantType: 'always' as const,
      },
    ],
  },
}

function setSettings(agentPermissions: typeof grants | Record<string, never> = {}) {
  useSettingsMock.mockReturnValue({
    data: {
      computerUse: { agentPermissions },
    },
  })
}

describe('ComputerUseTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getPlatformMock.mockReturnValue('darwin')
    useAgentsMock.mockReturnValue({
      data: [{ slug: 'designer-agent', name: 'Design Agent' }],
    })
    setSettings()
  })

  it('shows the compact caution and card-based empty state without the old legend', () => {
    render(<ComputerUseTab />)

    expect(screen.getByText('Persistent Permissions')).toBeInTheDocument()
    expect(
      screen.getByText('Agents you grant `always allow` computer use permissions will appear here.')
    ).toBeInTheDocument()
    expect(screen.getByText(/Review each request carefully/)).toBeInTheDocument()
    expect(screen.queryByText('Permission Levels')).not.toBeInTheDocument()
    expect(screen.queryByText('Security Warning')).not.toBeInTheDocument()
  })

  it('renders shared permission wording and contextual revoke names', () => {
    setSettings(grants)
    render(<ComputerUseTab />)

    expect(screen.getByText('Design Agent')).toBeInTheDocument()
    expect(screen.getByText('List Apps & Windows (read-only)')).toBeInTheDocument()
    expect(screen.getByText('Use Application — Figma')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Revoke List Apps & Windows (read-only) permission for Design Agent',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: 'Revoke all computer use permissions for Design Agent',
      })
    ).toBeInTheDocument()
  })

  it('removes only the selected grant', async () => {
    const user = userEvent.setup()
    setSettings(grants)
    render(<ComputerUseTab />)

    await user.click(
      screen.getByRole('button', {
        name: 'Revoke Use Application — Figma permission for Design Agent',
      })
    )

    expect(mutateMock).toHaveBeenCalledWith({
      computerUse: {
        agentPermissions: {
          'designer-agent': {
            grants: [grants['designer-agent'].grants[0]],
          },
        },
      },
    })
  })

  it('removes the agent when all permissions are revoked', async () => {
    const user = userEvent.setup()
    setSettings(grants)
    render(<ComputerUseTab />)

    await user.click(
      screen.getByRole('button', {
        name: 'Revoke all computer use permissions for Design Agent',
      })
    )

    expect(mutateMock).toHaveBeenCalledWith({
      computerUse: { agentPermissions: {} },
    })
  })

  it('keeps the unsupported-platform notice', () => {
    getPlatformMock.mockReturnValue('linux')
    render(<ComputerUseTab />)

    expect(screen.getByText('Not Available')).toBeInTheDocument()
    expect(screen.queryByText('Persistent Permissions')).not.toBeInTheDocument()
  })
})
