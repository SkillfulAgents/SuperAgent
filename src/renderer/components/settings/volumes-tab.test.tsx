// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'

const state = vi.hoisted(() => ({
  definitions: [] as VolumeDefinitionSummary[],
  selectedId: undefined as string | undefined, source: undefined as 'home' | undefined, from: undefined as string | undefined, navigate: vi.fn(), push: vi.fn(),
  host: true, isAdmin: true, save: vi.fn(), remove: vi.fn(),
}))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({
  useVolumeAgents: () => ({ data: { attachments: [] }, isLoading: false }),
  useVolumeDefinitions: () => ({ data: state.definitions, isLoading: false }),
  useSaveVolumeDefinition: () => ({ mutateAsync: state.save, isPending: false }),
  useDeleteVolumeDefinition: () => ({ mutateAsync: state.remove, isPending: false }),
}))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => state.host }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: state.isAdmin }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate, useRouter: () => ({ history: { push: state.push } }), useSearch: () => ({ volume: state.selectedId, source: state.source, from: state.from }) }))
vi.mock('@renderer/components/volumes/volume-file-browser', () => ({ VolumeFileBrowser: () => <div>Volume files</div> }))
vi.mock('@renderer/hooks/use-agents', () => ({ useAgents: () => ({ data: [{ slug: 'a1', displaySlug: 'a1', name: 'Ada' }], isLoading: false }) }))
vi.mock('@renderer/hooks/use-mounts', () => ({ useAddMount: () => ({}), useRemoveMount: () => ({}) }))
import { agentBackPath, VolumesTab } from './volumes-tab'

beforeEach(() => {
  vi.resetAllMocks()
  state.selectedId = undefined
  state.source = undefined
  state.from = undefined
  state.host = true
  state.isAdmin = true
  state.definitions = [{ id: 'v1', name: 'Notes', type: 'local', hostPath: '/notes', userId: 'alice', canManage: true, attachmentCount: 0, health: 'ok', globalAccess: null }]
  window.electronAPI = { openDirectory: vi.fn().mockResolvedValue('/new/folder') } as never
})
afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('volume settings', () => {
  it('renames from the title without offering to change its folder or attached mount paths', async () => {
    state.definitions[0].attachmentCount = 2
    state.selectedId = 'v1'
    render(<VolumesTab />)
    expect(screen.getByRole('button', { name: 'Remove drive' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/notes')
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Select folder location/ })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Set folder name')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /who can add/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Rename drive' }))
    await userEvent.clear(screen.getByTestId('volume-title-input'))
    await userEvent.type(screen.getByTestId('volume-title-input'), 'Team notes{Enter}')
    expect(state.save).toHaveBeenCalledWith({ id: 'v1', name: 'Team notes' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('shows Global disabled with the reason on a drive only its owner can add', () => {
    state.selectedId = 'v1'
    render(<VolumesTab />)
    expect(screen.getByRole('switch', { name: 'Global drive' })).toBeDisabled()
    expect(screen.getByText('Only drives Everyone can add can be global.')).toBeInTheDocument()
  })
  it('turns a public drive global after a confirm, then locks the access picker and lists every agent', async () => {
    state.definitions[0] = { ...state.definitions[0], userId: null }
    state.selectedId = 'v1'
    state.save.mockResolvedValue(undefined)
    const { rerender } = render(<VolumesTab />)
    expect(screen.getByRole('switch', { name: 'Global drive' })).not.toBeChecked()
    expect(screen.getByRole('combobox', { name: 'Access on every agent' })).toBeEnabled()
    await userEvent.click(screen.getByRole('switch', { name: 'Global drive' }))
    expect(state.save).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(state.save).toHaveBeenCalledExactlyOnceWith({ id: 'v1', global: 'read' })
    state.definitions[0] = { ...state.definitions[0], globalAccess: 'read' }
    rerender(<VolumesTab />)
    expect(screen.getByRole('combobox', { name: 'Access on every agent' })).toBeDisabled()
    expect(screen.getByText('Every agent has this drive')).toBeInTheDocument()
    expect(screen.queryByText('Agents Without This Drive')).not.toBeInTheDocument()
  })
  it('returns Back to an agent page only when the agent home opened the drive', () => {
    expect(agentBackPath('home', '/agents/a1')).toBe('/agents/a1')
    expect(agentBackPath('home', '/settings/general')).toBeNull()
    expect(agentBackPath('home', '/agents/a1/sessions/s1')).toBeNull()
    expect(agentBackPath(undefined, '/agents/a1')).toBeNull()
    expect(agentBackPath('home', undefined)).toBeNull()
    expect(agentBackPath('list', '/agents/a1')).toBeNull()
    expect(agentBackPath('home', '/agents/')).toBeNull()
    expect(agentBackPath('home', '/agents/a1?tab=files')).toBeNull()
  })
  it('shows a read-only title to people who cannot manage the drive', () => {
    state.selectedId = 'v1'
    state.definitions[0] = { ...state.definitions[0], canManage: false }
    render(<VolumesTab />)
    expect(screen.queryByRole('button', { name: 'Rename drive' })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Notes' })).toBeInTheDocument()
    cleanup()
    state.isAdmin = false
    state.definitions[0] = { ...state.definitions[0], canManage: true }
    render(<VolumesTab />)
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
  })
  it('returns an unavailable drive opened from an agent to that agent', async () => {
    state.selectedId = 'missing'
    state.source = 'home'
    state.from = '/agents/a1'
    render(<VolumesTab />)
    expect(screen.getByText('This drive is no longer available.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to Ada' }))
    expect(state.push).toHaveBeenCalledWith('/agents/a1')
  })
  it('returns Back to the agent the page was opened from, else to the list', async () => {
    state.selectedId = 'v1'
    state.source = 'home'
    state.from = '/agents/a1'
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Ada' }))
    expect(state.push).toHaveBeenCalledWith('/agents/a1')
    cleanup()
    state.navigate.mockClear()
    state.source = undefined
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Drives' }))
    expect(state.navigate.mock.calls[0][0].search({ from: '/agents/a1', volume: 'v1' })).toEqual({ from: '/agents/a1', volume: undefined, source: undefined })
  })
  it('creates a private volume using the native folder picker', async () => {
    state.isAdmin = false
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Add drive' }))
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Set folder name')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(window.electronAPI!.openDirectory).toHaveBeenCalledOnce()
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/new/folder')
    expect(screen.getByLabelText('Set folder name')).toHaveValue('folder')
    expect(screen.queryByLabelText('Who can add this drive?')).not.toBeInTheDocument()
    expect(screen.getByText('Only me')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(state.save).toHaveBeenCalledWith({ id: undefined, name: 'folder', source: { type: 'local', config: { path: '/new/folder' } }, visibility: 'private' })
  })
  it('opens the drive from anywhere on its row, as the list, not the agent it came from', async () => {
    render(<VolumesTab />)
    await userEvent.click(screen.getByText('/notes'))
    expect(state.navigate.mock.calls[0][0].search({ from: '/agents/a1', source: 'home' })).toEqual({ from: '/agents/a1', source: undefined, volume: 'v1' })
    expect(screen.queryByRole('button', { name: 'Edit Notes' })).not.toBeInTheDocument()
  })
  it('shows public sources without management controls for other users', () => {
    state.host = false
    state.isAdmin = false
    state.definitions[0] = { ...state.definitions[0], userId: null, canManage: false }
    render(<VolumesTab />)
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Notes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Notes' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add drive' })).toBeInTheDocument()
  })
  it('keeps inline edits with the server error when a volume cannot be saved', async () => {
    state.selectedId = 'v1'
    state.save.mockRejectedValue(new Error('Remove this drive from all agents before changing its access'))
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Remove this drive')
    expect(state.save).toHaveBeenCalledWith({ id: 'v1', visibility: 'private' })
    expect(screen.getByTestId('volume-detail-page')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('confirms deletion of an unused definition', async () => {
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Remove Notes' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The source folder and its files will remain unchanged')
    expect(state.remove).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Remove drive' }))
    expect(state.remove).toHaveBeenCalledWith('v1')
  })
})
