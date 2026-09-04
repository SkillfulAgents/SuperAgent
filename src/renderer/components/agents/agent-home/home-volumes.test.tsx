// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const manager = vi.hoisted(() => ({
  mounts: [] as unknown[],
  hostFolders: true,
  sharedVolumes: false,
  registry: [] as unknown[],
  registryReady: true,
  isLoading: false,
  pendingRestart: false,
  isRestarting: false,
  restartError: null as string | null,
  actionError: null as string | null,
  isAddingMount: false,
  isRemovingMount: false,
  canAddFolder: true,
  handleAddFolder: vi.fn(),
  handleRemove: vi.fn(),
  createShared: vi.fn(),
  attachShared: vi.fn(),
  detachShared: vi.fn(),
  deleteShared: vi.fn(),
  handleRestart: vi.fn(),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({ useVolumesManager: () => manager }))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({ mockCanUseHostFeatures: vi.fn(() => true) }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeVolumes } from './home-volumes'

const FOLDER = { id: 'm1', hostPath: '/Users/joe/code', containerPath: '/mounts/code', folderName: 'code', addedAt: '2026-01-01', source: 'folder', health: 'ok' }
const SHARED = { id: 'vol-1', hostPath: '/data/volumes/vol-1', containerPath: '/volumes/research', folderName: 'Research', addedAt: '2026-01-01', source: 'shared', health: 'ok' }
const RESEARCH = { id: 'vol-1', name: 'Research', mountName: 'research', attachedAgents: [{ slug: 'a1', name: 'Agent One' }, { slug: 'a2', name: 'Agent Two' }] }

beforeEach(() => {
  vi.clearAllMocks()
  manager.mounts = [FOLDER]
  manager.hostFolders = true
  manager.sharedVolumes = false
  manager.registry = []
  manager.registryReady = true
  manager.actionError = null
  manager.canAddFolder = true
  manager.pendingRestart = false
  mockCanUseHostFeatures.mockReturnValue(true)
  window.electronAPI = { platform: 'darwin', showInFolder: vi.fn() } as never
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('one card, both sources', () => {
  it('renders a folder row and a shared row from the records alone', () => {
    manager.mounts = [FOLDER, SHARED]
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('Volumes')).toBeTruthy()
    expect(screen.getByText('code')).toBeTruthy()
    expect(screen.getByText('/Users/joe/code')).toBeTruthy()
    expect(screen.getByText('Research')).toBeTruthy()
    expect(screen.getByText('/volumes/research')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mount actions' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Shared volume actions' })).toBeTruthy()
  })

  it('only the folder row opens in the file manager', async () => {
    manager.mounts = [FOLDER, SHARED]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByText('/Users/joe/code'))
    const showInFolder = (window.electronAPI as unknown as { showInFolder: ReturnType<typeof vi.fn> }).showInFolder
    expect(showInFolder).toHaveBeenCalledWith('/Users/joe/code')
    await userEvent.click(screen.getByText('/volumes/research'))
    expect(showInFolder).toHaveBeenCalledTimes(1)
  })

  it('shared row menu lists attached agents, offers detach, and hides delete when another agent holds it', async () => {
    manager.mounts = [SHARED]
    manager.registry = [RESEARCH]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Shared volume actions' }))
    expect(screen.getByText('Attached agents: Agent One, Agent Two')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Detach shared volume' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete shared volume' })).toBeNull()
  })

  it('hides delete while the registry has not loaded', async () => {
    manager.mounts = [SHARED]
    manager.registry = []
    manager.registryReady = false
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Shared volume actions' }))
    expect(screen.queryByRole('button', { name: 'Delete shared volume' })).toBeNull()
  })

  it('shows a shared-write failure on the card', () => {
    manager.mounts = [SHARED]
    manager.actionError = 'This agent already has the maximum of 19 shared volumes'
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByRole('alert').textContent).toBe('This agent already has the maximum of 19 shared volumes')
  })
})

describe('add menu follows the flags', () => {
  it('offers the folder entry and not the shared entries on desktop', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Add volume' }))
    expect(screen.getByRole('button', { name: 'Add folder from this computer' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New shared volume…' })).toBeNull()
  })

  it('offers the shared entries and not the folder entry on cloud', async () => {
    manager.hostFolders = false
    manager.sharedVolumes = true
    manager.canAddFolder = false
    manager.mounts = []
    manager.registry = [RESEARCH]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Add volume' }))
    expect(screen.getByRole('button', { name: 'New shared volume…' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Research Agent One, Agent Two' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add folder from this computer' })).toBeNull()
  })

  it('hides the folder entry when the window cannot pick a folder', async () => {
    manager.canAddFolder = false
    manager.sharedVolumes = true   // keeps the Add button rendered; the folder entry alone must vanish
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Add volume' }))
    expect(screen.getByRole('button', { name: 'New shared volume…' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add folder from this computer' })).toBeNull()
  })

  it('renders no Add button when no action is usable', () => {
    manager.canAddFolder = false
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: 'Add volume' })).toBeNull()
  })
})

describe('empty card', () => {
  it('hides when nothing is mounted and no action is usable', () => {
    manager.mounts = []
    manager.canAddFolder = false
    manager.sharedVolumes = false
    const { container } = render(<HomeVolumes agentSlug="a1" />)
    expect(container.textContent).toBe('')
  })

  it('shows the empty state when an action is usable', () => {
    manager.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('No volumes yet')).toBeTruthy()
  })
})
