// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query'

Element.prototype.scrollIntoView = vi.fn()
Element.prototype.hasPointerCapture = vi.fn(() => false)
Element.prototype.releasePointerCapture = vi.fn()

const Q4 = { id: 'vol_00000000-0000-0000-0000-000000000001', name: 'Q4 Plans' }
const LAUNCH = { id: 'vol_00000000-0000-0000-0000-000000000002', name: 'Launch' }
const state = vi.hoisted(() => ({ drives: [] as { id: string; name: string }[], created: [] as unknown[], listFails: false, holdCreate: null as Promise<void> | null, holdList: null as Promise<void> | null }))
vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => false }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: true }) }))
vi.mock('@renderer/lib/api', () => ({
  apiFetch: async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      await state.holdCreate
      state.created.push(body)
      if (body.name === 'Q4 Plans') return Response.json({ error: 'A Gamut drive with this name exists' }, { status: 409 })
      // Made on the platform, but the answer was lost on the way back.
      if (body.name === 'Lost') { state.drives = [{ id: 'vol_00000000-0000-0000-0000-000000000009', name: 'Lost' }, ...state.drives]; return new Response('upstream', { status: 503 }) }
      state.drives = [LAUNCH, ...state.drives]
      return Response.json({ folder: LAUNCH })
    }
    // A held read answers with what it found when it started.
    const drives = state.drives
    await state.holdList
    if (state.listFails) return Response.json({ error: 'Sign in to Gamut to use Gamut drives' }, { status: 403 })
    return Response.json({ folders: drives })
  },
}))
import { VolumeSettingsDialog } from './volume-settings-dialog'

afterEach(() => { cleanup(); state.drives = [Q4]; state.created = []; state.listFails = false; state.holdCreate = null; state.holdList = null; onlineManager.setOnline(true) })
state.drives = [Q4]
async function open(save = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <VolumeSettingsDialog onSave={save} onClose={vi.fn()} />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Gamut drive' }))
  await userEvent.click(screen.getByRole('button', { name: /^Drive/ }))
  return save
}

describe('Gamut drive setup', () => {
  it('picks an existing drive from the shared picker and saves it by id', async () => {
    const save = await open()
    await userEvent.click(await screen.findByRole('button', { name: 'Q4 Plans' }))
    // A drive is chosen whole: nothing to open, not even by double-click, and the level itself is not a drive.
    expect(screen.queryByRole('button', { name: 'Open Q4 Plans' })).not.toBeInTheDocument()
    await userEvent.dblClick(screen.getByRole('button', { name: 'Q4 Plans' }))
    expect(screen.getByRole('button', { name: 'Q4 Plans' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Q4 Plans' }))
    // From unselected, a double-click selects.
    await userEvent.dblClick(screen.getByRole('button', { name: 'Q4 Plans' }))
    expect(screen.getByRole('button', { name: 'Q4 Plans' })).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Use “Q4 Plans”' }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Q4 Plans')
    await userEvent.click(screen.getByRole('button', { name: 'Add drive' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Q4 Plans', source: { type: 'platform', config: { volumeId: Q4.id } } }))
  })

  it('makes a new drive from the New drive row, then saves the drive it made by id', async () => {
    const save = await open()
    await screen.findByRole('button', { name: 'Q4 Plans' })
    expect(screen.getByRole('button', { name: 'Select a drive' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'New drive' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New drive name' }), 'Launch{Enter}')
    expect(await screen.findByRole('button', { name: 'Launch' })).toHaveAttribute('aria-pressed', 'true')
    expect(state.created).toEqual([{ name: 'Launch' }])
    // Newest first, as the platform lists drives.
    expect(screen.getAllByRole('button', { name: /^(Launch|Q4 Plans)$/ }).map(row => row.textContent)).toEqual(['Launch', 'Q4 Plans'])
    await userEvent.click(screen.getByRole('button', { name: 'Use “Launch”' }))
    await userEvent.click(screen.getByRole('button', { name: 'Add drive' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Launch', source: { type: 'platform', config: { volumeId: LAUNCH.id } } }))
  })

  it('still offers a new drive after one was chosen and the picker reopened', async () => {
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'Q4 Plans' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use “Q4 Plans”' }))
    await userEvent.click(screen.getByRole('button', { name: /^Drive/ }))
    // Back at the list of drives, not inside the chosen one: nothing is highlighted, so Use waits for a pick.
    expect(await screen.findByRole('button', { name: 'Select a drive' })).toBeDisabled()
    await userEvent.click(await screen.findByRole('button', { name: 'New drive' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New drive name' }), 'Launch{Enter}')
    expect(await screen.findByRole('button', { name: 'Use “Launch”' })).toBeEnabled()
  })

  it('lets an input method confirm or cancel a candidate without making a drive or closing anything', async () => {
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'New drive' }))
    const field = screen.getByRole('textbox', { name: 'New drive name' })
    await userEvent.type(field, 'Launch')
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(field, { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(field, { key: 'Escape', isComposing: true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(state.created).toEqual([])
    expect(screen.getByRole('textbox', { name: 'New drive name' })).toHaveValue('Launch')
  })

  it('reads the drives again when making one failed, so a drive the platform made anyway can be picked', async () => {
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'New drive' }))
    await userEvent.type(screen.getByRole('textbox', { name: 'New drive name' }), 'Lost{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not create it. Please try again.')
    expect(await screen.findByRole('button', { name: 'Lost' })).toBeInTheDocument()
  })

  it('shows the platform refusing a taken name under the field', async () => {
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'New drive' }))
    // A listing read now would hang, so any re-read shows as Loading.
    state.holdList = new Promise(() => {})
    await userEvent.type(screen.getByRole('textbox', { name: 'New drive name' }), 'Q4 Plans{Enter}')
    expect(await screen.findByRole('alert')).toHaveTextContent('A Gamut drive with this name exists')
    expect(screen.getByRole('textbox', { name: 'New drive name' })).toBeInTheDocument()
    // A refusal made nothing, so the list stays as it is.
    expect(screen.queryByText('Loading drives…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Q4 Plans' })).toBeInTheDocument()
  })

  it('lets a picked name follow the pick, and keeps a typed one', async () => {
    state.drives = [Q4, LAUNCH]
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'Q4 Plans' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use “Q4 Plans”' }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Q4 Plans')
    // A name filled from the previous pick follows the new one.
    await userEvent.click(screen.getByRole('button', { name: /^Drive/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use “Launch”' }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Launch')
    await userEvent.clear(screen.getByLabelText('Name', { exact: true }))
    await userEvent.type(screen.getByLabelText('Name', { exact: true }), 'Mine')
    await userEvent.click(screen.getByRole('button', { name: /^Drive/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Launch' }))
    await userEvent.click(screen.getByRole('button', { name: 'Use “Launch”' }))
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Mine')
  })

  it('shows why drives cannot load and offers a retry', async () => {
    state.listFails = true
    await open()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to Gamut to use Gamut drives')
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  const nameField = () => screen.getByRole('textbox', { name: 'New drive name' })
  async function startNaming() {
    await open()
    await userEvent.click(await screen.findByRole('button', { name: 'New drive' }))
  }

  it('gives the reason for a bad name, and Escape or an empty name closes only the row, focusing New drive', async () => {
    await startNaming()
    await userEvent.type(nameField(), 'a/b{Enter}')
    expect(screen.getByRole('alert')).toHaveTextContent('Use a single folder name')
    expect(state.created).toEqual([])
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'New drive name' })).not.toBeInTheDocument()
    expect(screen.getByTestId('platform-folder-picker')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'New drive' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'New drive' }))
    await userEvent.type(nameField(), '{Enter}')
    expect(screen.getByRole('button', { name: 'New drive' })).toBeInTheDocument()
  })

  it('holds the picker while a drive is being made, through Escape and a Cancel and reopen', async () => {
    let release = () => {}
    state.holdCreate = new Promise(resolve => { release = resolve })
    await startNaming()
    await userEvent.type(nameField(), 'Launch{Enter}')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Q4 Plans' })).toBeDisabled())
    expect(nameField()).toHaveAttribute('readonly')
    await userEvent.keyboard('{Escape}')
    expect(nameField()).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await userEvent.click(screen.getByRole('button', { name: /^Drive/ }))
    expect(nameField()).toHaveAttribute('readonly')
    release()
    expect(await screen.findByRole('button', { name: 'Launch' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Launch' })).toHaveFocus()
  })

  it('keeps a made drive, listed once, when a listing read before it lands after it', async () => {
    let releaseCreate = () => {}
    state.holdCreate = new Promise(resolve => { releaseCreate = resolve })
    await startNaming()
    await userEvent.type(nameField(), 'Launch{Enter}')
    let releaseList = () => {}
    state.holdList = new Promise(resolve => { releaseList = resolve })
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    releaseCreate()
    expect(await screen.findByRole('button', { name: 'Use “Launch”' })).toBeEnabled()
    state.holdList = null
    releaseList()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(screen.getAllByRole('button', { name: 'Launch' })).toHaveLength(1)
  })

  it('keeps an open name row through a failed refresh, and moves focus only once', async () => {
    await startNaming()
    await userEvent.type(nameField(), 'Draft')
    state.listFails = true
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    expect(await screen.findByText('Sign in to Gamut to use Gamut drives')).toBeInTheDocument()
    expect(nameField()).toHaveValue('Draft')
    // Nothing is made into a listing that failed to load.
    await userEvent.type(nameField(), '{Enter}')
    expect(state.created).toEqual([])
    state.listFails = false
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByRole('button', { name: 'Q4 Plans' })
    await userEvent.clear(nameField())
    await userEvent.type(nameField(), 'Launch{Enter}')
    expect(await screen.findByRole('button', { name: 'Launch' })).toHaveFocus()
    act(() => screen.getByRole('button', { name: 'Cancel' }).focus())
    let releaseList = () => {}
    state.holdList = new Promise(resolve => { releaseList = resolve })
    onlineManager.setOnline(false)
    onlineManager.setOnline(true)
    await screen.findByText('Loading drives…')
    state.holdList = null
    releaseList()
    await screen.findByRole('button', { name: 'New drive' })
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()
  })
})
