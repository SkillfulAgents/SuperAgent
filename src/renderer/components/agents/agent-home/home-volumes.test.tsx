// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const volumes = vi.hoisted(() => ({
  mounts: [] as { id: string; volumeId?: string; name: string; type: string; hostPath: string | null; health?: unknown }[],
  definitions: [] as { id: string; name: string; hostPath: string }[],
  canModifyMounts: true,
  operationError: null as string | null,
  handleAttach: vi.fn(),
  isLoading: false,
  pendingRestart: false,
  isRestarting: false,
  restartError: null as string | null,
  isAddingMount: false,
  isRemovingMount: false,
  canAddMount: true,
  canCreateMount: true,
  handleCreateMount: vi.fn(),
  handleRemove: vi.fn(),
  handleRestart: vi.fn(),
}))
vi.mock('@renderer/hooks/use-mounts', () => ({ useVolumesManager: () => volumes }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeVolumes } from './home-volumes'

/**
 * Local folder picking/revealing needs this computer. Saved volumes belong to
 * the selected API target and can also be attached from browsers/cloud windows.
 */

const MOUNT = { id: 'm1', volumeId: 'v1', name: 'code', type: 'local', hostPath: '/Users/joe/code' }

beforeEach(() => {
  vi.clearAllMocks()
  volumes.mounts = [MOUNT]
  volumes.canAddMount = true
  volumes.canCreateMount = true
  volumes.canModifyMounts = true
  volumes.definitions = []
  volumes.operationError = null
  volumes.pendingRestart = false
  mockCanUseHostFeatures.mockReturnValue(true)
  window.electronAPI = { platform: 'darwin', showInFolder: vi.fn(), openDirectory: vi.fn().mockResolvedValue('/new/folder') } as never
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

describe('a volume with no local folder', () => {
  it('lists it by name, with no path, open or copy action', async () => {
    volumes.mounts = [{ id: 'd1', name: 'drive', type: 'gdrive', hostPath: null }]
    render(<HomeVolumes agentSlug="a1" />)

    expect(screen.getByText('drive')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mount actions' }))
    expect(screen.queryByRole('button', { name: /open in finder/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy path/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove mount/i })).toBeInTheDocument()
  })
})

describe('driving a cloud workspace', () => {
  beforeEach(() => {
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canCreateMount = false
    volumes.canAddMount = false
  })

  it('does not offer to create a local volume on another machine', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add mount/i })).not.toBeInTheDocument()
    expect(window.electronAPI!.openDirectory).not.toHaveBeenCalled()
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

  it('does not show a local-folder creation flow when there are no saved volumes or mounts', () => {
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add mount/i })).not.toBeInTheDocument()
  })
})


describe('saved volume picker', () => {
  beforeEach(() => {
    volumes.definitions = [
      { id: 'v1', name: 'code', hostPath: '/Users/joe/code' },
      { id: 'v2', name: 'notes', hostPath: '/Users/joe/notes' },
    ]
  })
  it('offers saved sources and New Volume, disabling mounted sources', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    expect(screen.getByRole('menuitem', { name: /code.*mounted/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: /new volume/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
    expect(volumes.handleCreateMount).not.toHaveBeenCalled()
  })
  it('retains the existing folder picker for adding a new source', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /new volume/i }))
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create and attach' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/new/folder')
    await userEvent.click(screen.getByRole('button', { name: 'Create and attach' }))
    expect(window.electronAPI!.openDirectory).toHaveBeenCalledOnce()
    expect(volumes.handleCreateMount).toHaveBeenCalledWith({ name: 'folder', path: '/new/folder', visibility: 'private' })
  })
  it('attaches saved volumes remotely without offering the native folder picker', async () => {
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canCreateMount = false
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    expect(screen.queryByRole('menuitem', { name: /new volume/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
  })
  it('creates and attaches with the OS picker, with New Volume after a separator', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    const create = screen.getByRole('menuitem', { name: 'New Volume' })
    expect(create.previousElementSibling).toHaveAttribute('role', 'separator')
    expect(screen.getAllByRole('menuitem').at(-1)).toBe(create)
    await userEvent.click(create)
    await userEvent.type(screen.getByLabelText('Name'), 'Reports')
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create and attach' }))
    expect(volumes.handleCreateMount).toHaveBeenCalledWith({ name: 'Reports', path: '/new/folder', visibility: 'private' })
    expect(volumes.handleAttach).not.toHaveBeenCalled()
  })
  it('hides attachment and removal controls from viewers', async () => {
    volumes.canModifyMounts = false
    volumes.canAddMount = false
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add mount/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Mount actions' }))
    expect(screen.queryByRole('button', { name: /remove mount/i })).not.toBeInTheDocument()
  })
})
