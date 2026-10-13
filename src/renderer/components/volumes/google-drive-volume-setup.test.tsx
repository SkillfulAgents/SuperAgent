// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const state = vi.hoisted(() => ({ accounts: [{ id: 'first', displayName: 'Work Drive', status: 'active' }] }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({ data: { accounts: state.accounts }, isLoading: false }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string) => {
    const folderId = new URL(url, 'http://app').searchParams.get('folderId')
    if (!folderId) return Response.json({ folders: [{ id: 'mydrive', name: 'My Drive' }, { id: 'shared1', name: 'Shared drive' }] })
    return Response.json({ folders: folderId === 'mydrive' ? [{ id: 'team', name: 'Team' }] : [] })
  },
}))
vi.mock('@renderer/components/connections/integration-directory-dialog', () => ({
  IntegrationDirectoryDialog: ({ onApiConnected, onOpenChange }: { onApiConnected: (result: { accountId: string; toolkit: string }) => void; onOpenChange: (open: boolean) => void }) =>
    <button type="button" onClick={() => {
      state.accounts.push({ id: 'new', displayName: 'New Drive', status: 'active' })
      onApiConnected({ accountId: 'new', toolkit: 'googledrive' })
      onOpenChange(false)
    }}>Finish connecting Google Drive</button>,
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

beforeEach(() => { state.accounts = [{ id: 'first', displayName: 'Work Drive', status: 'active' }, { id: 'second', displayName: 'Personal Drive', status: 'active' }] })
afterEach(cleanup)
async function setup(save = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Google Drive' }))
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  return save
}
async function chooseAccount(account = 'Work Drive') {
  await userEvent.click(screen.getByLabelText('Google Drive account', { exact: true }))
  await userEvent.click(screen.getByRole('option', { name: account }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
}
async function chooseTeam() {
  await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
  await screen.findByText('Shared drive')
  expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'My Drive' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Team' }))
  await screen.findByText('No subfolders')
  await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
}

describe('Google Drive volume creation', () => {
  it('walks My Drive to a folder, names the volume after it, and saves the folder ID', async () => {
    const save = await setup()
    await chooseAccount()
    expect(screen.getByText(/Saving one updates the Google file/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
    await chooseTeam()
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('My Drive / Team')
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Team')
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(save).toHaveBeenCalledWith({ name: 'Team', source: { type: 'googledrive', config: { accountId: 'first', folderId: 'team', folderName: 'Team', driveName: 'My Drive' } }, visibility: 'private' })
  })

  it('requires a new folder selection when switching accounts', async () => {
    await setup()
    await chooseAccount()
    await chooseTeam()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await chooseAccount('Personal Drive')
    expect(screen.queryByTestId('selected-volume-folder')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
  })

  it('continues with a newly connected account and steps back up through the picker', async () => {
    await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Google Drive account' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Finish connecting Google Drive' }))
    await waitFor(() => expect(screen.getByLabelText('Google Drive account', { exact: true })).toHaveTextContent('New Drive'))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(screen.getByRole('button', { name: 'Parent folder' })).toBeDisabled()
    await userEvent.click(await screen.findByRole('button', { name: 'My Drive' }))
    await screen.findByRole('button', { name: 'Team' })
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
    await screen.findByText('Shared drive')
    expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  })
})
