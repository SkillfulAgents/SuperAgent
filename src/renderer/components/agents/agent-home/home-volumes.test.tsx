// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const volumes = vi.hoisted(() => ({
  mounts: [] as { id: string; volumeId?: string; name: string; volumeName: string; type: string; hostPath: string | null; health?: unknown; global?: true; sourceReadOnly?: boolean }[],
  definitions: [] as { id: string; name: string; hostPath: string; canManage?: boolean }[],
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
const { navigate, save, toastError } = vi.hoisted(() => ({ navigate: vi.fn(), save: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate, useRouterState: ({ select }: { select: (s: { location: { href: string } }) => unknown }) => select({ location: { href: here.current } }) }))
const here = vi.hoisted(() => ({ current: '/agents/a1' }))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({ useSaveVolumeDefinition: () => ({ mutateAsync: save }) }))

const { mockCanUseHostFeatures } = vi.hoisted(() => ({
  mockCanUseHostFeatures: vi.fn(() => true),
}))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: mockCanUseHostFeatures }))

import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeVolumes } from './home-volumes'
import { TEAM_BRAIN_AGENT_HOME_QUERY } from '@renderer/lib/team-brain/team-brain-agent-home'

/**
 * Local folder picking/revealing needs this computer. Saved volumes belong to
 * the selected API target and can also be attached from browsers/cloud windows.
 */

const MOUNT = { id: 'm1', volumeId: 'v1', name: 'code', volumeName: 'code', type: 'local', hostPath: '/Users/joe/code' }

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
  window.electronAPI = { platform: 'darwin', showInFolder: vi.fn(), openDirectory: vi.fn().mockResolvedValue({ path: '/new/folder' }) } as never
})

afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('driving this computer', () => {
  it('offers to add a drive', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByRole('button', { name: /add drive/i })).toBeInTheDocument()
  })

  it('opens a mount in the file manager', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    await userEvent.click(screen.getByRole('button', { name: /open in finder/i }))

    expect(window.electronAPI!.showInFolder).toHaveBeenCalledWith('/Users/joe/code')
  })
})

describe('a volume with no local folder', () => {
  it('lists it by name, with no path, open or copy action', async () => {
    volumes.mounts = [{ id: 'd1', name: 'drive', volumeName: 'drive', type: 'gdrive', hostPath: null }]
    render(<HomeVolumes agentSlug="a1" />)

    expect(screen.getByText('drive')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    expect(screen.queryByRole('button', { name: /open in finder/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy path/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /remove from agent/i })).toBeInTheDocument()
  })
})

describe('a source that refuses writes', () => {
  it('shows Read only and offers no read-only toggle', async () => {
    volumes.mounts = [{ id: 'g1', name: 'repo', volumeName: 'repo', type: 'github', hostPath: null, sourceReadOnly: true }]
    render(<HomeVolumes agentSlug="a1" />)

    expect(screen.getByText('Read only')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    expect(screen.queryByRole('switch', { name: /read only/i })).not.toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /add drive/i })).not.toBeInTheDocument()
    expect(window.electronAPI!.openDirectory).not.toHaveBeenCalled()
  })

  it('still lists the mounts, which are real on whichever Superagent is driven', () => {
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('code')).toBeInTheDocument()
    expect(screen.getByText('/Users/joe/code')).toBeInTheDocument()
    expect(screen.queryByText('/mounts/code')).not.toBeInTheDocument()
  })

  it('drops the open-in-file-manager action', async () => {
    render(<HomeVolumes agentSlug="a1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))

    expect(screen.queryByRole('button', { name: /open in finder/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy path/i })).toBeInTheDocument()
  })

  it('opens the drive settings from the row, back to this agent', async () => {
    volumes.definitions = [{ id: 'v1', name: 'code', hostPath: '/Users/joe/code' }]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByText('code'))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/$tab', params: { tab: 'volumes' }, search: { volume: 'v1', source: 'home', from: '/agents/a1' } })
  })

  it('opens the drive settings back to the page it was opened from, with what that page carries in its URL', async () => {
    volumes.definitions = [{ id: 'v1', name: 'code', hostPath: '/Users/joe/code' }]
    here.current = `/agents/a1?${TEAM_BRAIN_AGENT_HOME_QUERY}`
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByText('code'))
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/$tab', params: { tab: 'volumes' }, search: { volume: 'v1', source: 'home', from: `/agents/a1?${TEAM_BRAIN_AGENT_HOME_QUERY}` } })
    here.current = '/agents/a1'
  })

  it('leaves the row inert when this viewer cannot open the drive\'s settings', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByText('code'))
    expect(navigate).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Open code drive settings' })).not.toBeInTheDocument()
  })

  it('does not show a local-folder creation flow when there are no saved volumes or mounts', () => {
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add drive/i })).not.toBeInTheDocument()
  })
})


describe('saved volume picker', () => {
  beforeEach(() => {
    volumes.definitions = [
      { id: 'v1', name: 'code', hostPath: '/Users/joe/code' },
      { id: 'v2', name: 'notes', hostPath: '/Users/joe/notes' },
    ]
  })
  it('offers saved sources and New Drive, disabling added sources', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add drive/i }))
    expect(screen.getByRole('menuitem', { name: /code.*added/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: /new drive/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
    expect(volumes.handleCreateMount).not.toHaveBeenCalled()
  })
  it('retains the existing folder picker for adding a new source', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add drive/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /new drive/i }))
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/new/folder')
    await userEvent.click(screen.getByRole('button', { name: 'Create and add' }))
    expect(window.electronAPI!.openDirectory).toHaveBeenCalledOnce()
    expect(volumes.handleCreateMount).toHaveBeenCalledWith({ name: 'folder', source: { type: 'local', config: { path: '/new/folder' } }, visibility: 'private' })
  })
  it('attaches saved volumes remotely without offering the native folder picker', async () => {
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canCreateMount = false
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add drive/i }))
    expect(screen.queryByRole('menuitem', { name: /new drive/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
  })
  it('creates and attaches with the OS picker, with New Drive after a separator', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add drive/i }))
    const create = screen.getByRole('menuitem', { name: 'New Drive' })
    expect(create.previousElementSibling).toHaveAttribute('role', 'separator')
    expect(screen.getAllByRole('menuitem').at(-1)).toBe(create)
    await userEvent.click(create)
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Reports')
    await userEvent.click(screen.getByRole('button', { name: 'Create and add' }))
    expect(volumes.handleCreateMount).toHaveBeenCalledWith({ name: 'Reports', source: { type: 'local', config: { path: '/new/folder' } }, visibility: 'private' })
    expect(volumes.handleAttach).not.toHaveBeenCalled()
  })
  it('hides attachment and removal controls from viewers', async () => {
    volumes.canModifyMounts = false
    volumes.canAddMount = false
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.queryByRole('button', { name: /add drive/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    expect(screen.queryByRole('button', { name: /remove from agent/i })).not.toBeInTheDocument()
  })

  it('labels a global drive and offers no removal or access change on it', async () => {
    volumes.mounts = [{ ...MOUNT, global: true }]
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('Global')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    expect(screen.queryByRole('button', { name: /remove from agent/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: /read only/i })).not.toBeInTheDocument()
  })
})


describe('renaming', () => {
  it('renames the drive, not this agent\'s attachment', async () => {
    volumes.definitions = [{ id: 'v1', name: 'code', hostPath: '/Users/joe/code', canManage: true }]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.clear(await screen.findByRole('textbox', { name: 'Rename drive' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Rename drive' }), 'Code base{Enter}')
    expect(save).toHaveBeenCalledWith({ id: 'v1', name: 'Code base' })
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rejects a name with a slash before saving, and Escape makes the row clickable again', async () => {
    volumes.definitions = [{ id: 'v1', name: 'code', hostPath: '/Users/joe/code', canManage: true }]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.clear(screen.getByRole('textbox', { name: 'Rename drive' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Rename drive' }), 'a/b{Enter}')
    expect(save).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('Failed to rename drive', { description: 'Use a single folder name' })
    expect(screen.queryByRole('button', { name: 'Open code drive settings' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.getByRole('button', { name: 'Open code drive settings' })).toBeInTheDocument()
  })

  it('hides Rename from people who cannot manage the drive', async () => {
    volumes.definitions = [{ id: 'v1', name: 'code', hostPath: '/Users/joe/code', canManage: false }]
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Drive actions' }))
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument()
  })

  it('shows the drive name, and the agent\'s folder path once they differ', () => {
    volumes.mounts = [{ ...MOUNT, volumeName: 'Code base' }]
    render(<HomeVolumes agentSlug="a1" />)
    expect(screen.getByText('Code base')).toBeInTheDocument()
    expect(screen.getByText('/mounts/code')).toBeInTheDocument()
  })
})
