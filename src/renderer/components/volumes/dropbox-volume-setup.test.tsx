// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const state = vi.hoisted(() => ({ accounts: [{ id: 'first', displayName: 'Work Dropbox', status: 'active' }] }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({ data: { accounts: state.accounts }, isLoading: false }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: async () => Response.json({ folders: [] }) }))
vi.mock('@renderer/components/connections/integration-directory-dialog', () => ({
  IntegrationDirectoryDialog: ({ onApiConnected, onOpenChange }: { onApiConnected: (result: { accountId: string; toolkit: string }) => void; onOpenChange: (open: boolean) => void }) =>
    <button type="button" onClick={() => {
      state.accounts.push({ id: 'new', displayName: 'New Dropbox', status: 'active' })
      onApiConnected({ accountId: 'new', toolkit: 'dropbox' })
      onOpenChange(false)
    }}>Finish connecting Dropbox</button>,
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

beforeEach(() => { state.accounts = [{ id: 'first', displayName: 'Work Dropbox', status: 'active' }, { id: 'second', displayName: 'Personal Dropbox', status: 'active' }] })
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
  expect(screen.queryByRole('button', { name: 'Select folder' })).not.toBeInTheDocument()
  return save
}
async function chooseRoot(account = 'Work Dropbox') {
  await userEvent.click(screen.getByLabelText('Dropbox account', { exact: true }))
  await userEvent.click(screen.getByRole('option', { name: account }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
  await screen.findByText('No subfolders')
  await userEvent.click(screen.getByRole('button', { name: 'Use Dropbox root' }))
}

describe('Dropbox volume creation', () => {
  it('continues with the account returned by the existing OAuth dialog', async () => {
    const save = await setup()
    await userEvent.click(screen.getByRole('button', { name: 'Connect Dropbox account' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Finish connecting Dropbox' }))
    await waitFor(() => expect(screen.getByLabelText('Dropbox account', { exact: true })).toHaveTextContent('New Dropbox'))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await screen.findByText('No subfolders')
    await userEvent.click(screen.getByRole('button', { name: 'Use Dropbox root' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(save).toHaveBeenCalledWith({ name: 'Dropbox', source: { type: 'dropbox', config: { accountId: 'new', path: '' } }, visibility: 'private' })
  })

  it('requires a new folder selection when switching accounts', async () => {
    await setup()
    await chooseRoot()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByLabelText('Dropbox account', { exact: true }))
    await userEvent.click(screen.getByRole('option', { name: 'Personal Dropbox' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.queryByTestId('selected-volume-folder')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
  })

  it('retains a selected folder on cancellation and preserves it when saving fails', async () => {
    const save = await setup(vi.fn().mockRejectedValue(new Error('Connection expired')))
    await chooseRoot()
    await userEvent.clear(screen.getByLabelText('Name', { exact: true }))
    await userEvent.type(screen.getByLabelText('Name', { exact: true }), 'My shared files')
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    await userEvent.click(within(screen.getByTestId('dropbox-folder-picker')).getByRole('button', { name: 'Cancel' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('Entire Dropbox')
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection expired')
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'My shared files', source: { type: 'dropbox', config: { accountId: 'first', path: '' } } }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('My shared files')
  })
})
