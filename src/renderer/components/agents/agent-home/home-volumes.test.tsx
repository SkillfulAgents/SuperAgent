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

const shared = vi.hoisted(() => ({
  supported: false,
  attached: [] as Array<{
    id: string
    name: string
    mountName: string
    attachedAgents: Array<{ slug: string; name: string }>
  }>,
  all: [] as Array<{
    id: string
    name: string
    mountName: string
    attachedAgents: Array<{ slug: string; name: string }>
  }>,
  isLoading: false,
  create: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  remove: vi.fn(),
  pendingRestart: false,
  handleRestart: vi.fn(),
  isRestarting: false,
  restartError: null as string | null,
  isAgentRunning: false,
}))
vi.mock('@renderer/hooks/use-shared-volumes', () => ({ useSharedVolumes: () => shared }))

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
  shared.supported = false
  shared.attached = []
  shared.all = []
  shared.pendingRestart = false
  shared.isAgentRunning = false
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

describe('shared volumes when the server reports supported', () => {
  const RESEARCH = {
    id: 'vol-1',
    name: 'Research',
    mountName: 'research',
    attachedAgents: [{ slug: 'a1', name: 'Agent One' }],
  }
  const ORPHAN = {
    id: 'vol-2',
    name: 'Archive',
    mountName: 'archive',
    attachedAgents: [],
  }

  beforeEach(() => {
    shared.supported = true
    shared.attached = []
    shared.all = [ORPHAN]
    shared.pendingRestart = false
  })

  it('shows the Shared Volumes card and locked empty-state copy', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('Shared Volumes')).toBeInTheDocument()
    expect(screen.getByText('No shared volumes yet')).toBeInTheDocument()
    expect(screen.getByText(
      'Create a shared folder in your workspace. Every agent you attach it to can read and write its files.',
    )).toBeInTheDocument()
  })

  it('opens the add menu with create, existing list, and orphan delete', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add shared volume/i }))
    expect(screen.getByRole('button', { name: /new shared volume/i })).toBeInTheDocument()
    expect(screen.getByText('Archive')).toBeInTheDocument()
    expect(screen.getByText('No agents attached')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete archive/i })).toBeInTheDocument()
  })

  it('validates the create dialog and shows the derived mount path', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add shared volume/i }))
    await userEvent.click(screen.getByRole('button', { name: /new shared volume/i }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required')
    await userEvent.type(screen.getByLabelText(/name/i), 'Team Brain')
    expect(screen.getByText('/volumes/team-brain', { exact: false })).toBeInTheDocument()
  })

  it('attaches from the menu and shows the restart banner only when the agent is running', async () => {
    shared.isAgentRunning = true
    shared.pendingRestart = false
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add shared volume/i }))
    await userEvent.click(screen.getByRole('button', { name: /archive.*no agents attached/i }))
    expect(shared.attach).toHaveBeenCalledWith('vol-2')
    expect(volumes.handleAddMount).not.toHaveBeenCalled()

    shared.attached = [RESEARCH]
    shared.pendingRestart = true
    cleanup()
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText(/restart your agent for mount changes/i)).toBeInTheDocument()
  })

  it('lists an attached row without a health pill and with the cloud menu', async () => {
    shared.attached = [RESEARCH]
    shared.all = [RESEARCH]
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('Research')).toBeInTheDocument()
    expect(screen.getByText('/volumes/research')).toBeInTheDocument()
    expect(screen.queryByText(/^ok$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^missing$/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /shared volume actions/i }))
    expect(screen.queryByRole('button', { name: /copy path/i })).not.toBeInTheDocument()
    expect(screen.getByText(/attached agents: agent one/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /detach shared volume/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete shared volume/i })).toBeInTheDocument()
  })

  it('never calls handleAddMount from the cloud branch', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add shared volume/i }))
    await userEvent.click(screen.getByRole('button', { name: /new shared volume/i }))
    expect(volumes.handleAddMount).not.toHaveBeenCalled()
  })
})
