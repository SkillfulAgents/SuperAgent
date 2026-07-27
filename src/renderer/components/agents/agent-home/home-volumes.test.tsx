// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const volumes = vi.hoisted(() => ({
  mounts: [] as { id: string; folderName: string; hostPath: string; health?: unknown }[],
  isLoading: false,
  pendingRestart: false,
  isRestarting: false,
  restartError: null as string | null,
  isAddingMount: false,
  isRemovingMount: false,
  canAddMount: true,
  handleAddMount: vi.fn(),
  handleRemove: vi.fn(),
  handleRestart: vi.fn(),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({ useVolumesManager: () => volumes }))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeVolumes } from './home-volumes'

/**
 * A volume is a path on the machine that runs the agent. Every affordance here
 * — pick one, open one in Finder — reaches *this* computer, so they mean
 * something only while the two are the same machine.
 */

const MOUNT = { id: 'm1', folderName: 'code', hostPath: '/Users/joe/code' }

beforeEach(() => {
  vi.clearAllMocks()
  volumes.mounts = [MOUNT]
  volumes.canAddMount = true
  volumes.pendingRestart = false
  mockCanUseHostFeatures.mockReturnValue(true)
  window.electronAPI = { platform: 'darwin', showInFolder: vi.fn() } as never
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('driving this computer', () => {
  it('offers to add a mount', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByRole('button', { name: /add mount/i })).toBeInTheDocument()
  })

  it('opens a mount in the file manager', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Mount actions' }))
    await userEvent.click(screen.getByRole('button', { name: /open in finder/i }))

    expect(window.electronAPI!.showInFolder).toHaveBeenCalledWith('/Users/joe/code')
  })
})

describe('driving a cloud workspace', () => {
  beforeEach(() => {
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canAddMount = false
  })

  it('does not offer a directory picker that would browse the wrong machine', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add mount/i })).not.toBeInTheDocument()
  })

  it('still lists the mounts, which are real on whichever Superagent is driven', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('code')).toBeInTheDocument()
    expect(screen.getByText('/Users/joe/code')).toBeInTheDocument()
  })

  it('drops the open-in-file-manager action', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Mount actions' }))

    expect(screen.queryByRole('button', { name: /open in finder/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument()
  })

  it('does not leave the row looking clickable', () => {
    render(<HomeVolumes agentSlug="a1" />)

    // The row is the primary open-in-Finder target. Left as a focusable
    // role=button it would promise an action this window cannot perform.
    const rows = screen.queryAllByRole('button').filter((el) => el.textContent?.includes('code'))
    expect(rows).toHaveLength(0)
  })

  it('hides the section entirely when there is nothing mounted', () => {
    volumes.mounts = []
    const { container } = render(<HomeVolumes agentSlug="a1" />)

    // Otherwise: an empty box inviting you to "mount a folder from your
    // computer", with no button to do it.
    expect(container).toBeEmptyDOMElement()
  })
})
