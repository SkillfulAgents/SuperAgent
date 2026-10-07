// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render as renderComponent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { VolumeDefinitionSummary } from '@shared/lib/types/mount'

const state = vi.hoisted(() => ({
  definitions: [] as VolumeDefinitionSummary[],
  host: true, isAdmin: true, save: vi.fn(), remove: vi.fn(),
}))
vi.mock('@renderer/hooks/use-volume-definitions', () => ({
  useVolumeDefinitions: () => ({ data: state.definitions, isLoading: false }),
  useSaveVolumeDefinition: () => ({ mutateAsync: state.save, isPending: false }),
  useDeleteVolumeDefinition: () => ({ mutateAsync: state.remove, isPending: false }),
}))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => state.host }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: state.isAdmin }) }))
import { VolumesTab } from './volumes-tab'

const browse = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/api', () => ({ apiFetch: browse }))
function render(ui: React.ReactNode) {
  return renderComponent(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  vi.resetAllMocks()
  state.host = true
  state.isAdmin = true
  state.definitions = [{ id: 'v1', name: 'Notes', type: 'local', hostPath: '/notes', userId: 'alice', canManage: true, attachmentCount: 0, health: 'ok' }]
  browse.mockImplementation(async (url: string) => ({ ok: true, json: async () => ({
    path: url.includes('?') ? '/srv/reports' : '/srv', parent: '/', locations: [{ name: 'Home', path: '/srv' }],
    folders: url.includes('?') ? [] : [{ name: 'reports', path: '/srv/reports' }],
  }) }))
  window.electronAPI = { openDirectory: vi.fn().mockResolvedValue('/new/folder') } as never
})
afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('volume settings', () => {
  it('edits a definition without offering to change its folder or attached mount paths', async () => {
    state.definitions[0].attachmentCount = 2
    render(<VolumesTab />)
    expect(screen.getByRole('button', { name: 'Delete Notes' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Edit Notes' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/notes')
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Select folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('combobox')).toBeDisabled()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Team notes')
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(state.save).toHaveBeenCalledWith({ id: 'v1', name: 'Team notes', path: undefined, visibility: 'private' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })
  it('creates a private volume using the native folder picker', async () => {
    state.isAdmin = false
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Add volume' }))
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(window.electronAPI!.openDirectory).toHaveBeenCalledOnce()
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/new/folder')
    expect(screen.getByLabelText('Name')).toHaveValue('folder')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.getByText('Only me')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(state.save).toHaveBeenCalledWith({ id: undefined, name: 'folder', path: '/new/folder', visibility: 'private' })
  })
  it('shows public sources without management controls for other users', () => {
    state.host = false
    state.isAdmin = false
    state.definitions[0] = { ...state.definitions[0], userId: null, canManage: false }
    render(<VolumesTab />)
    expect(screen.getByText('Public')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Notes' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete Notes' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add volume' })).toBeInTheDocument()
  })
  it('selects a workspace folder in a browser without a path field', async () => {
    state.host = false
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Add volume' }))
    expect(screen.queryByRole('textbox', { name: 'Folder' })).not.toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Name'), 'Reports')
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open reports' }))
    await waitFor(() => expect(screen.getByTestId('volume-picker-location')).toHaveTextContent('/srv/reports'))
    await userEvent.click(screen.getByRole('button', { name: 'Select this folder' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/srv/reports')
    expect(window.electronAPI!.openDirectory).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(state.save).toHaveBeenCalledWith({ id: undefined, name: 'Reports', path: '/srv/reports', visibility: 'private' })
  })
  it('keeps the dialog open with the server error when a volume cannot be saved', async () => {
    state.save.mockRejectedValue(new Error('Detach this volume from all agents before changing its access'))
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Edit Notes' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Detach this volume')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
  it('confirms deletion of an unused definition', async () => {
    render(<VolumesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Delete Notes' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The folder and its files will stay on disk')
    expect(state.remove).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Delete volume' }))
    expect(state.remove).toHaveBeenCalledWith('v1')
  })
})
