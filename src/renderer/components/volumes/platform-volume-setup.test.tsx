// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const state = vi.hoisted(() => ({ list: async () => Response.json({ folders: [{ id: 'vol_00000000-0000-0000-0000-000000000001', name: 'Q4 Plans' }] }) }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: true }) }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: () => state.list() }))
import { VolumeSettingsDialog } from './volume-settings-dialog'

const listDrives = state.list
afterEach(() => { cleanup(); state.list = listDrives })
async function open(save = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Gamut drive' }))
  await userEvent.click(await screen.findByLabelText('Drive'))
  return save
}

describe('Gamut drive setup', () => {
  it('saves an existing drive by id, and a new one by name', async () => {
    const save = await open()
    await userEvent.click(await screen.findByRole('option', { name: 'Q4 Plans' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add drive' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Q4 Plans', source: { type: 'platform', config: { volumeId: 'vol_00000000-0000-0000-0000-000000000001' } } }))
    cleanup()

    const create = await open()
    await userEvent.click(await screen.findByRole('option', { name: 'New drive' }))
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Name'), 'Launch')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch', source: { type: 'platform', config: { name: 'Launch' } } }))
  })

  it('lets a picked name follow the pick, and keeps a typed one', async () => {
    await open()
    await userEvent.click(await screen.findByRole('option', { name: 'Q4 Plans' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Q4 Plans')
    await userEvent.click(screen.getByLabelText('Drive'))
    await userEvent.click(await screen.findByRole('option', { name: 'New drive' }))
    expect(screen.getByLabelText('Name')).toHaveValue('')
    await userEvent.type(screen.getByLabelText('Name'), 'Mine')
    await userEvent.click(screen.getByLabelText('Drive'))
    await userEvent.click(await screen.findByRole('option', { name: 'Q4 Plans' }))
    expect(screen.getByLabelText('Name')).toHaveValue('Mine')
  })

  it('picks the drive a failed save created, so trying again adds it', async () => {
    const created = { id: 'vol_00000000-0000-0000-0000-000000000002', name: 'Launch' }
    const save = vi.fn().mockImplementationOnce(async () => {
      state.list = async () => Response.json({ folders: [{ id: 'vol_00000000-0000-0000-0000-000000000001', name: 'Q4 Plans' }, created] })
      throw new Error('Drive could not be loaded')
    })
    await open(save)
    await userEvent.click(await screen.findByRole('option', { name: 'New drive' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Launch')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(await screen.findByText('“Launch” was created and is picked now.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Drive could not be loaded')
    await userEvent.click(screen.getByRole('button', { name: 'Add drive' }))
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Launch', source: { type: 'platform', config: { volumeId: created.id } } }))
  })

  it('leaves the pick alone when the name was already taken', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('A Gamut drive with this name exists'))
    await open(save)
    await userEvent.click(await screen.findByRole('option', { name: 'New drive' }))
    await userEvent.type(screen.getByLabelText('Name'), 'Q4 Plans')
    await userEvent.click(screen.getByRole('button', { name: 'Create drive' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('A Gamut drive with this name exists')
    expect(screen.getByRole('button', { name: 'Create drive' })).toBeInTheDocument()
  })

  it('shows why drives cannot load and offers a retry', async () => {
    state.list = async () => Response.json({ error: 'Sign in to Gamut to use Gamut drives' }, { status: 403 })
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VolumeSettingsDialog onSave={vi.fn()} onClose={vi.fn()} />
    </QueryClientProvider>)
    await userEvent.click(screen.getByRole('button', { name: 'Gamut drive' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to Gamut to use Gamut drives')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
