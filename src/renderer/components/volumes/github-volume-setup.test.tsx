// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const requests = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/capabilities', () => ({ canUseHostFeatures: () => false, usesHostFolderPaths: () => false, agentsRunInAppSandbox: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({
  data: { accounts: [{ id: 'account', displayName: 'Work GitHub', status: 'active' }] }, isLoading: false,
}) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: requests }))
vi.mock('@renderer/hooks/use-connect-account', () => ({
  useConnectAccount: () => ({ connect: async () => {}, connecting: null, canCancel: false, cancel: () => {}, error: null }),
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

afterEach(cleanup)

it('selects a repository, branch and folder by repository ID', async () => {
  requests.mockImplementation(async (url: string) => {
    const query = new URL(url, 'http://app').searchParams
    if (!query.has('repoId')) return Response.json({ folders: [{ id: '123', name: 'team/project' }] })
    expect(query.get('repoId')).toBe('123')
    if (!query.has('branch')) return Response.json({ folders: [{ id: 'release/docs', name: 'release/docs' }] })
    expect(query.get('branch')).toBe('release/docs')
    return Response.json({ folders: query.get('path') === '' ? [{ id: 'docs', name: 'docs' }] : [] })
  })
  const save = vi.fn()
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'GitHub' }))
  await userEvent.click(screen.getByRole('radio', { name: 'Work GitHub' }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
  // A repository can only be opened: picking one leaves nothing to confirm until a branch is chosen.
  await userEvent.click(await screen.findByRole('button', { name: 'team/project' }))
  expect(screen.getByRole('button', { name: 'Select a repo' })).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Open team/project' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Open release/docs' }))
  await screen.findByRole('button', { name: 'Open docs' })
  expect(screen.getByRole('button', { name: 'Use repository root' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Open docs' }))
  await screen.findByText('No folders in docs')
  await userEvent.click(screen.getByRole('button', { name: 'Use “docs”' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create drive' })).toBeEnabled())
  expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('team/project@release/docs/docs')
  await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
  expect(save).toHaveBeenCalledWith({ name: 'docs', visibility: 'private', source: {
    type: 'github', config: { accountId: 'account', repoId: 123, owner: 'team', repo: 'project', branch: 'release/docs', path: 'docs' },
  } })
})

it('makes a repository at the top, picks it by the ID GitHub returned, offers no New inside it, and saves it', async () => {
  const created: unknown[] = []
  const save = vi.fn()
  requests.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { created.push(JSON.parse(String(init.body))); return Response.json({ folder: { id: '456', name: 'me/scratch' } }) }
    const query = new URL(url, 'http://app').searchParams
    if (!query.has('repoId')) return Response.json({ folders: [{ id: '123', name: 'team/project' }] })
    expect(query.get('repoId')).toBe('456')
    return Response.json({ folders: query.has('branch') ? [] : [{ id: 'main', name: 'main' }] })
  })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'GitHub' }))
  await userEvent.click(screen.getByRole('radio', { name: 'Work GitHub' }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: /^Select folder location/ }))
  await screen.findByRole('button', { name: 'team/project' })
  await userEvent.click(screen.getByRole('button', { name: 'New repo' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'New repo name' }), 'scratch{Enter}')
  expect(await screen.findByRole('button', { name: 'me/scratch' })).toHaveAttribute('aria-pressed', 'true')
  expect(created).toEqual([{ accountId: 'account', name: 'scratch' }])
  await userEvent.click(screen.getByRole('button', { name: 'Open me/scratch' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Open main' }))
  await screen.findByText('No folders in main')
  expect(screen.queryByRole('button', { name: /^New / })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Use repository root' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create drive' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'scratch', source: {
    type: 'github', config: { accountId: 'account', repoId: 456, owner: 'me', repo: 'scratch', branch: 'main', path: '' },
  } }))
})
