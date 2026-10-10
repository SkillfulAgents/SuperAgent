// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@renderer/lib/host-features', () => ({ canUseHostFeatures: () => true }))
vi.mock('@renderer/context/user-context', () => ({ useUser: () => ({ isAuthMode: false, isAdmin: true }) }))
import { VolumeSettingsDialog } from './volume-settings-dialog'

const picker = vi.fn()
beforeEach(() => {
  picker.mockReset()
  window.electronAPI = { openDirectory: picker } as never
})
afterEach(() => {
  cleanup()
  delete (window as { electronAPI?: unknown }).electronAPI
})

describe('volume folder selection', () => {
  it('keeps the chosen folder and custom name when the picker is cancelled', async () => {
    picker.mockResolvedValueOnce('/documents').mockResolvedValueOnce(null)
    const save = vi.fn()
    render(<VolumeSettingsDialog onSave={save} onClose={vi.fn()} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(picker).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(picker).toHaveBeenCalledOnce()
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'Shared documents')
    await userEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/documents')
    expect(screen.getByLabelText('Name')).toHaveValue('Shared documents')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(save).toHaveBeenCalledWith({ name: 'Shared documents', source: { type: 'local', config: { path: '/documents' } }, visibility: 'public' })
  })

  it('shows picker failures and lets the user try selecting again', async () => {
    picker.mockRejectedValueOnce(new Error('Could not open folder picker')).mockResolvedValueOnce('/reports')
    render(<VolumeSettingsDialog onSave={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open folder picker')
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeEnabled()
  })

  it('stays on source selection when the native picker is cancelled', async () => {
    picker.mockResolvedValueOnce(null).mockResolvedValueOnce('/reports')
    const save = vi.fn()
    render(<VolumeSettingsDialog onSave={save} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(screen.getByRole('button', { name: 'Dropbox' })).toBeVisible()
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument()
    expect(save).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    expect(screen.getByLabelText('Name')).toHaveValue('reports')
    await userEvent.clear(screen.getByLabelText('Name'))
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
  })

  it('validates the volume name before saving and supports returning to sources', async () => {
    picker.mockResolvedValue('/reports')
    const save = vi.fn()
    render(<VolumeSettingsDialog onSave={save} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Local folder' }))
    await userEvent.clear(screen.getByLabelText('Name'))
    await userEvent.type(screen.getByLabelText('Name'), 'invalid/name')
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Use a single folder name')
    expect(save).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.getByRole('button', { name: 'Local folder' })).toBeVisible()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
