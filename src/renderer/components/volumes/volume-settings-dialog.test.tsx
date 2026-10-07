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
    await userEvent.type(screen.getByLabelText('Name'), 'Shared documents')
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'Change folder' }))
    expect(screen.getByTestId('selected-volume-folder')).toHaveTextContent('/documents')
    expect(screen.getByLabelText('Name')).toHaveValue('Shared documents')
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'Create volume' }))
    expect(save).toHaveBeenCalledWith({ name: 'Shared documents', path: '/documents', visibility: 'public' })
  })

  it('shows picker failures and lets the user try selecting again', async () => {
    picker.mockRejectedValueOnce(new Error('Could not open folder picker')).mockResolvedValueOnce('/reports')
    render(<VolumeSettingsDialog onSave={vi.fn()} onClose={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not open folder picker')
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Select folder' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create volume' })).toBeEnabled()
  })
})
