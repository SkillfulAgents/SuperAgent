// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const volumes = vi.hoisted(() => ({
  mounts: [] as { id: string; folderName: string; hostPath: string; containerPath?: string; health?: unknown }[],
  sharedVolumes: undefined as string[] | undefined,
  isLoading: false,
  pendingRestart: false,
  isRestarting: false,
  restartError: null as string | null,
  isAddingMount: false,
  isRemovingMount: false,
  canAddMount: true,
  handleAddMount: vi.fn(),
  handleAddSharedVolume: vi.fn(),
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
  volumes.sharedVolumes = undefined
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

describe('on a server that mounts shared volumes', () => {
  const VOLUME = { id: 'v1', folderName: 'team-brain', hostPath: '/data/volumes/team-brain', containerPath: '/mounts/team-brain' }

  beforeEach(() => {
    // The picker lists the workspace disk, so it works from any window.
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canAddMount = true
    volumes.sharedVolumes = ['research', 'team-brain']
    volumes.mounts = [VOLUME]
  })

  it('offers the volumes this agent does not have yet and mounts the one picked', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    expect(screen.queryByRole('button', { name: 'team-brain' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'research' }))

    expect(volumes.handleAddSharedVolume).toHaveBeenCalledWith('research')
  })

  it('creates a new volume under the name the typed text converts to', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    await userEvent.click(screen.getByRole('button', { name: /new shared volume/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /volume name/i }), 'Q3 Planning')
    expect(screen.getByText('/mounts/q3-planning')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create' }))

    expect(volumes.handleAddSharedVolume).toHaveBeenCalledWith('q3-planning')
  })

  it('shows and copies the path the agent sees, not the workspace disk path', async () => {
    const writeText = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    render(<HomeVolumes agentSlug="a1" />)

    expect(screen.getByText('/mounts/team-brain')).toBeInTheDocument()
    expect(screen.queryByText('/data/volumes/team-brain')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mount actions' }))
    await userEvent.click(screen.getByRole('button', { name: /copy path/i }))
    expect(writeText).toHaveBeenCalledWith('/mounts/team-brain')
  })

  it('invites a shared volume, not a folder from your computer, when nothing is mounted', () => {
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)

    expect(screen.getByText(/add a shared volume/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add mount/i })).toBeInTheDocument()
  })
})
