// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const state = vi.hoisted(() => ({ failTop: false, connects: [] as string[], accounts: [{ id: 'first', displayName: 'Work Drive', status: 'active' }] }))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({ data: { accounts: state.accounts }, isLoading: false }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string) => {
    const folderId = new URL(url, 'http://app').searchParams.get('folderId')
    if (!folderId && state.failTop) return Response.json({ error: 'Google Drive is unavailable' }, { status: 503 })
    if (!folderId) return Response.json({ folders: [{ id: 'mydrive', name: 'My Drive' }, { id: 'shared1', name: 'Shared drive' }] })
    return Response.json({ folders: folderId === 'mydrive' ? [{ id: 'team', name: 'Team' }] : [] })
  },
}))
// Connect goes straight into the provider's sign-in; here it hands back a new account at once.
vi.mock('@renderer/hooks/use-connect-account', () => ({
  useConnectAccount: ({ onConnected }: { onConnected: (result: { accountId: string; toolkit: string }) => void }) => ({
    connect: async (toolkit: string) => {
      state.connects.push(toolkit)
      state.accounts.push({ id: 'new', displayName: 'New Drive', status: 'active' })
      onConnected({ accountId: 'new', toolkit })
    },
    connecting: null, canCancel: false, cancel: () => {}, error: null,
  }),
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

beforeEach(() => { state.failTop = false; state.connects = []; state.accounts = [{ id: 'first', displayName: 'Work Drive', status: 'active' }, { id: 'second', displayName: 'Personal Drive', status: 'active' }] })
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
  await userEvent.click(screen.getByRole('radio', { name: account }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
}
// The picker opens in My Drive; Team is opened, and the folder you are in is the one used.
async function chooseTeam() {
  await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Open Team' }))
  await screen.findByText('No folders in Team')
  expect(within(screen.getByRole('navigation', { name: 'Folder path' })).getByText('Team')).toHaveAttribute('aria-current', 'location')
  await userEvent.click(screen.getByRole('button', { name: 'Use “Team”' }))
}

describe('Google Drive volume creation', () => {
  it('walks My Drive to a folder, names the volume after it, and saves the folder ID', async () => {
    const save = await setup()
    await chooseAccount()
    expect(screen.getByText(/Saving one updates the Google file/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeDisabled()
    await chooseTeam()
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('My Drive / Team')
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Team')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(save).toHaveBeenCalledWith({ name: 'Team', source: { type: 'googledrive', config: { accountId: 'first', folderId: 'team', folderName: 'Team', driveName: 'My Drive' } }, visibility: 'private' })
  })

  it('requires a new folder selection when switching accounts', async () => {
    await setup()
    await chooseAccount()
    await chooseTeam()
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await chooseAccount('Personal Drive')
    expect(screen.queryByTestId('selected-volume-folder')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('')
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeDisabled()
  })

  it('lists accounts as radios, and picks a selected folder without opening it', async () => {
    await setup()
    const accounts = screen.getByRole('radiogroup', { name: 'Google Drive account' })
    expect(within(accounts).getAllByRole('radio').map(radio => radio.textContent)).toEqual(['Work Drive', 'Personal Drive'])
    await chooseAccount()
    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    // My Drive itself can be used, or a folder in it selected and used without opening it.
    await screen.findByRole('button', { name: 'Team' })
    expect(screen.getByRole('button', { name: 'Use “My Drive”' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Team' }))
    expect(screen.getByRole('button', { name: 'Team' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Use “Team”' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('My Drive / Team')
  })

  it('continues with a newly connected account and steps back up through the picker', async () => {
    await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Connect another Google Drive account' }))
    expect(state.connects).toEqual(['googledrive'])
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New Drive' })).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    await screen.findByRole('button', { name: 'Team' })
    expect(screen.getByRole('button', { name: 'Use “My Drive”' })).toBeEnabled()
    // Up to the top, where My Drive and the shared drives are: a drive is chosen there, the top itself can't be.
    await userEvent.click(screen.getByRole('button', { name: 'Parent folder' }))
    await screen.findByText('Shared drive')
    expect(screen.getByRole('button', { name: 'Parent folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Select a folder' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Shared drive' }))
    expect(screen.getByRole('button', { name: 'Use “Shared drive”' })).toBeEnabled()
  })
  it('shows a failed first load with Try again, then opens in My Drive', async () => {
    state.failTop = true
    await setup()
    await chooseAccount()
    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Google Drive is unavailable')
    state.failTop = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'Open Team' })).toBeInTheDocument()
  })
})
