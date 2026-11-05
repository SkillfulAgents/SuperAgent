// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const state = vi.hoisted(() => ({ connects: [] as string[], accounts: [{ id: 'first', displayName: 'Work Dropbox', status: 'active' }] as { id: string; displayName: string; status: string; createdAt?: string }[] }))
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => false, usesHostFolderPaths: () => false, agentsRunInAppSandbox: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({ data: { accounts: state.accounts }, isLoading: false }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: async () => Response.json({ folders: [] }) }))
// Connect goes straight into the provider's sign-in; here it hands back a new account at once.
vi.mock('@renderer/hooks/use-connect-account', () => ({
  useConnectAccount: ({ onConnected }: { onConnected: (result: { accountId: string; toolkit: string }) => void }) => ({
    connect: async (toolkit: string) => {
      state.connects.push(toolkit)
      state.accounts.push({ id: 'new', displayName: 'New Dropbox', status: 'active' })
      onConnected({ accountId: 'new', toolkit })
    },
    connecting: null, canCancel: false, cancel: () => {}, error: null,
  }),
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

beforeEach(() => { state.connects = []; state.accounts = [{ id: 'first', displayName: 'Work Dropbox', status: 'active' }, { id: 'second', displayName: 'Personal Dropbox', status: 'active' }] })
afterEach(cleanup)
async function setup(save = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  expect(screen.getByRole('button', { name: 'Local folder' })).toBeDisabled()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Dropbox' }))
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^Select folder location/ })).not.toBeInTheDocument()
  return save
}
async function chooseRoot(account = 'Work Dropbox') {
  await userEvent.click(screen.getByRole('radio', { name: account }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
  await screen.findByText('No folders in Dropbox')
  await userEvent.click(screen.getByRole('button', { name: 'Use all of Dropbox' }))
}

describe('Dropbox volume creation', () => {
  it('with no account shows only Connect, and a first account goes straight on to the folder', async () => {
    state.accounts = []
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VolumeSettingsDialog onSave={vi.fn()} onClose={vi.fn()} />
    </QueryClientProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Dropbox' }))
    // Nothing to choose from, so no account list.
    expect(screen.queryByRole('radiogroup', { name: 'Dropbox account' })).not.toBeInTheDocument()
    expect(screen.getByText('Sign in to Dropbox, then choose a folder to add.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Dropbox' }))
    expect(await screen.findByTestId('selected-volume-account')).toHaveTextContent('New Dropbox')
    expect(screen.getByRole('button', { name: /^Select folder location/ })).toBeInTheDocument()
  })

  it('chooses the lone usable account for you', async () => {
    state.accounts = [{ id: 'first', displayName: 'Work Dropbox', status: 'active' }, { id: 'old', displayName: 'Old Dropbox', status: 'expired' }]
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VolumeSettingsDialog onSave={vi.fn()} onClose={vi.fn()} />
    </QueryClientProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Dropbox' }))
    expect(screen.getByRole('radio', { name: 'Work Dropbox' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Connect another Dropbox account' })).toBeInTheDocument()
  })

  it('dates each account, to the minute where two share a name', async () => {
    state.accounts = [
      { id: 'a', displayName: 'Work Dropbox', status: 'active', createdAt: '2026-10-20T16:05:00' },
      { id: 'b', displayName: 'Work Dropbox', status: 'active', createdAt: '2026-10-21T09:30:00' },
      { id: 'c', displayName: 'Team Dropbox', status: 'active', createdAt: '2026-09-02T18:40:00' },
      { id: 'd', displayName: 'Shared Dropbox', status: 'active' },
    ]
    await setup()
    expect(screen.getAllByRole('radio').map(radio => radio.textContent)).toEqual([
      'Work DropboxConnected Oct 20, 2026, 4:05 PM', 'Work DropboxConnected Oct 21, 2026, 9:30 AM', 'Team DropboxConnected Sep 2, 2026', 'Shared Dropbox',
    ])
  })

  it('connects another account straight from the step, and continues with it', async () => {
    const save = await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Connect another Dropbox account' }))
    expect(state.connects).toEqual(['dropbox'])
    // With accounts to choose from, the new one is chosen but the step waits for Next.
    await waitFor(() => expect(screen.getByRole('radio', { name: 'New Dropbox' })).toHaveAttribute('aria-checked', 'true'))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    await screen.findByText('No folders in Dropbox')
    await userEvent.click(screen.getByRole('button', { name: 'Use all of Dropbox' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(save).toHaveBeenCalledWith({ name: 'Dropbox', source: { type: 'dropbox', config: { accountId: 'new', path: '' } }, visibility: 'private' })
  })

  it('requires a new folder selection when switching accounts', async () => {
    await setup()
    await chooseRoot()
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Personal Dropbox' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByTestId('selected-volume-folder')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeDisabled()
  })

  it('retains a selected folder on cancellation and preserves it when saving fails', async () => {
    const save = await setup(vi.fn().mockRejectedValue(new Error('Connection expired')))
    await chooseRoot()
    await userEvent.clear(screen.getByLabelText('Name', { exact: true }))
    await userEvent.type(screen.getByLabelText('Name', { exact: true }), 'My shared files')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
    await userEvent.click(within(screen.getByTestId('dropbox-folder-picker')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('Entire Dropbox')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection expired')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'My shared files', source: { type: 'dropbox', config: { accountId: 'first', path: '' } } }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('My shared files')
  })
})

it('offers no New folder, since Dropbox does not create folders here', async () => {
  await setup()
  await userEvent.click(screen.getByRole('radio', { name: 'Work Dropbox' }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
  await screen.findByText('No folders in Dropbox')
  expect(screen.queryByRole('button', { name: 'New folder' })).not.toBeInTheDocument()
})
