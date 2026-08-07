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

  it('shows the local version when driving local', () => {
    render(
      <SidebarVersion
        drivingCloud={false}
        cloudVersion="v0.5.0"
        onOpenUpdates={onOpenUpdates}
      />,
    )
    expect(screen.getByTestId('sidebar-version')).toHaveTextContent('v0.5.1-rc.1')
    expect(screen.queryByTestId('sidebar-cloud-version')).not.toBeInTheDocument()
  })

  it('shows the cloud version when driving cloud', () => {
    render(
      <SidebarVersion drivingCloud cloudVersion="v0.5.0" onOpenUpdates={onOpenUpdates} />,
    )
    expect(screen.getByTestId('sidebar-cloud-version')).toHaveTextContent('cloud v0.5.0')
    expect(screen.getByTestId('sidebar-version')).toHaveAttribute(
      'title',
      'Cloud workspace v0.5.0',
    )
  })

  it('falls back to local version in cloud mode when cloud version is unknown', () => {
    render(
      <SidebarVersion drivingCloud cloudVersion={null} onOpenUpdates={onOpenUpdates} />,
    )
    expect(screen.getByTestId('sidebar-version')).toHaveTextContent('v0.5.1-rc.1')
    expect(screen.queryByTestId('sidebar-cloud-version')).not.toBeInTheDocument()
  })

  it('keeps the electron update cue', () => {
    mockUseUpdateStatus.mockReturnValue({
      state: 'available',
      version: '0.5.2',
    } as never)
    render(
      <SidebarVersion
        drivingCloud={false}
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
        drivingCloud={false}
        cloudVersion={null}
        onOpenUpdates={onOpenUpdates}
      />,
    )
    await userEvent.click(screen.getByTestId('sidebar-version'))
    expect(onOpenUpdates).toHaveBeenCalled()
  })
})
