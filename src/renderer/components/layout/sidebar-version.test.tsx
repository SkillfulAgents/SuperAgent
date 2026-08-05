// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { SidebarVersion } from './sidebar-version'

vi.stubGlobal('__APP_VERSION__', '0.5.1-rc.1')

const mockUseUpdateStatus = vi.hoisted(() => vi.fn(() => ({ state: 'idle' as const })))
vi.mock('@renderer/context/update-status-context', () => ({
  useUpdateStatus: () => mockUseUpdateStatus(),
}))

describe('SidebarVersion', () => {
  const onOpenUpdates = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockUseUpdateStatus.mockReturnValue({ state: 'idle' })
  })

  it('shows only the local version when no cloud workspace is connected', () => {
    render(
      <SidebarVersion
        cloudConnected={false}
        cloudVersion={null}
        onOpenUpdates={onOpenUpdates}
      />,
    )
    expect(screen.getByTestId('sidebar-version')).toHaveTextContent('v0.5.1-rc.1')
    expect(screen.queryByTestId('sidebar-cloud-version')).not.toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-version-drift')).not.toBeInTheDocument()
  })

  it('shows cloud version without a drift cue when versions match', () => {
    render(
      <SidebarVersion
        cloudConnected
        cloudVersion="v0.5.1-rc.1"
        onOpenUpdates={onOpenUpdates}
      />,
    )
    expect(screen.getByTestId('sidebar-cloud-version')).toHaveTextContent('cloud v0.5.1-rc.1')
    expect(screen.queryByTestId('sidebar-version-drift')).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-version')).toHaveAttribute(
      'title',
      'Local and cloud: v0.5.1-rc.1',
    )
  })

  it('shows an amber drift cue when cloud and local differ', () => {
    render(
      <SidebarVersion cloudConnected cloudVersion="v0.5.0" onOpenUpdates={onOpenUpdates} />,
    )
    expect(screen.getByTestId('sidebar-cloud-version')).toHaveTextContent('cloud v0.5.0')
    expect(screen.getByTestId('sidebar-version-drift')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-version')).toHaveAttribute(
      'title',
      'Local v0.5.1-rc.1 · Cloud v0.5.0',
    )
  })

  it('treats bare and v-prefixed cloud versions as equal to local', () => {
    render(
      <SidebarVersion
        cloudConnected
        cloudVersion="0.5.1-rc.1"
        onOpenUpdates={onOpenUpdates}
      />,
    )
    expect(screen.queryByTestId('sidebar-version-drift')).not.toBeInTheDocument()
  })

  it('keeps the electron update cue when not drifted', () => {
    mockUseUpdateStatus.mockReturnValue({
      state: 'available',
      version: '0.5.2',
    } as never)
    render(
      <SidebarVersion
        cloudConnected={false}
        cloudVersion={null}
        onOpenUpdates={onOpenUpdates}
      />,
    )
    expect(screen.getByLabelText('Update available')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-version')).toHaveAttribute(
      'title',
      'Update available: v0.5.2',
    )
  })

  it('opens updates settings on click', async () => {
    render(
      <SidebarVersion
        cloudConnected={false}
        cloudVersion={null}
        onOpenUpdates={onOpenUpdates}
      />,
    )
    await userEvent.click(screen.getByTestId('sidebar-version'))
    expect(onOpenUpdates).toHaveBeenCalled()
  })
})
