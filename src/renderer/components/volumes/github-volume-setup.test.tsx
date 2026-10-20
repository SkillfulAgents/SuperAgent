// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const requests = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
vi.mock('@renderer/hooks/use-connected-accounts', () => ({ useConnectedAccountsByToolkit: () => ({
  data: { accounts: [{ id: 'account', displayName: 'Work GitHub', status: 'active' }] }, isLoading: false,
}) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: requests }))
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
  await userEvent.click(screen.getByLabelText('GitHub account', { exact: true }))
  await userEvent.click(screen.getByRole('option', { name: 'Work GitHub' }))
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
  expect(screen.getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  await userEvent.click(await screen.findByRole('button', { name: 'team/project' }))
  await userEvent.click(await screen.findByRole('button', { name: 'release/docs' }))
  await screen.findByRole('button', { name: 'docs' })
  expect(screen.getByRole('button', { name: 'Use repository root' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'docs' }))
  await screen.findByText('No subfolders')
  await userEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create drive' })).toBeEnabled())
  expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('team/project@release/docs/docs')
  await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
  expect(save).toHaveBeenCalledWith({ name: 'docs', visibility: 'private', source: {
    type: 'github', config: { accountId: 'account', repoId: 123, owner: 'team', repo: 'project', branch: 'release/docs', path: 'docs' },
  } })
})
