// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: fetch }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: true, isAdmin: false }) }))
import { VolumeSettingsDialog } from './volume-settings-dialog'
afterEach(cleanup)
beforeEach(() => fetch.mockReset())
const good = { valid: true, checks: [{ label: 'Read objects', status: 'passed' }, { label: 'Delete objects', status: 'passed' }], warnings: [] }

async function setup() {
  const save = vi.fn().mockResolvedValue({ id: 'created' })
  render(<QueryClientProvider client={new QueryClient()}><VolumeSettingsDialog onSave={save} onClose={vi.fn()} /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'S3-compatible bucket' }))
  await userEvent.type(screen.getByLabelText('Endpoint URL'), 'https://example.r2.cloudflarestorage.com')
  await userEvent.type(screen.getByLabelText('Bucket', { exact: true }), 'example-bucket')
  await userEvent.type(screen.getByLabelText('Access key ID'), 'test-key')
  await userEvent.type(screen.getByLabelText('Secret access key'), 'test-secret')
  return save
}

describe('S3 volume setup', () => {
  it('tests access before allowing creation and defaults R2 to auto', async () => {
    const save = await setup()
    expect(screen.getByLabelText('Region')).toHaveValue('auto')
    expect(screen.getByLabelText('Secret access key')).toHaveAttribute('type', 'password')
    expect(screen.queryByRole('button', { name: 'Create drive' })).not.toBeInTheDocument()
    fetch.mockResolvedValue(Response.json(good))
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(screen.getByLabelText('Set folder name', { exact: true })).toHaveValue('example-bucket')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'example-bucket', visibility: 'private', source: expect.objectContaining({ type: 's3' }) }))
    expect(fetch).toHaveBeenCalledWith('/api/volume-types/s3/validate', expect.objectContaining({ method: 'POST' }))
  })
  it('shows permission failures and cleanup warnings without allowing save', async () => {
    await setup()
    fetch.mockResolvedValue(Response.json({ valid: false, checks: [{ label: 'Delete objects', status: 'failed', message: 'Grant s3:DeleteObject for this bucket.' }], warnings: ['Remove the temporary object at example/.gamut-check-test/object.'] }))
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(await screen.findByText('Grant s3:DeleteObject for this bucket.')).toBeVisible()
    expect(screen.getByText(/Remove the temporary object/)).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create drive' })).not.toBeInTheDocument()
  })
  it('invalidates a successful check when connection details change', async () => {
    await setup(); fetch.mockResolvedValue(Response.json(good))
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await screen.findByRole('button', { name: 'Continue' })
    await userEvent.type(screen.getByLabelText('Folder prefix (optional)'), 'another-prefix')
    expect(screen.queryByTestId('s3-validation-result')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
  })
  it('recovers from unavailable validation without dropping connection details', async () => {
    await setup(); fetch.mockResolvedValue(new Response('Unavailable', { status: 503 }))
    await userEvent.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeVisible())
    expect(screen.getByLabelText('Bucket', { exact: true })).toHaveValue('example-bucket')
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled()
  })
})
