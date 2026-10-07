// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const volumes = vi.hoisted(() => ({
  mounts: [] as { id: string; volumeId?: string; name: string; type: string; hostPath: string | null; health?: unknown }[],
  definitions: [] as { id: string; name: string; hostPath: string }[],
  canCreateMount: true,
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
    volumes.canAddMount = false
    volumes.canCreateMount = false
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


describe('saved volume picker', () => {
  beforeEach(() => {
    volumes.definitions = [
      { id: 'v1', name: 'code', hostPath: '/Users/joe/code' },
      { id: 'v2', name: 'notes', hostPath: '/Users/joe/notes' },
    ]
  })
  it('offers saved sources and adding a new folder, disabling mounted sources', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    expect(screen.getByRole('menuitem', { name: /code.*mounted/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('menuitem', { name: /add new folder/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
    expect(volumes.handleAddMount).not.toHaveBeenCalled()
  })
  it('retains the existing folder picker for adding a new source', async () => {
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /add new folder/i }))
    expect(volumes.handleAddMount).toHaveBeenCalledOnce()
  })
  it('attaches saved volumes remotely without offering the native folder picker', async () => {
    mockCanUseHostFeatures.mockReturnValue(false)
    volumes.canCreateMount = false
    volumes.mounts = []
    render(<HomeVolumes agentSlug="a1" />)
    await userEvent.click(screen.getByRole('button', { name: /add mount/i }))
    expect(screen.queryByRole('menuitem', { name: /add new folder/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitem', { name: /notes/i }))
    expect(volumes.handleAttach).toHaveBeenCalledWith('v2')
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
