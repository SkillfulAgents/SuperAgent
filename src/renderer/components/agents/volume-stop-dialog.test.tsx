// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { VolumeStopDialog } from './volume-stop-dialog'
import { fetchWithVolumeStopConfirmation } from '@renderer/lib/volume-stop'
import { apiFetch } from '@renderer/lib/api'

vi.mock('@renderer/lib/api', () => ({ apiFetch: vi.fn() }))
const request = vi.mocked(apiFetch)
const declined = () => Response.json({ code: 'volume_stop_deferred', error: 'Uploads have not finished. Active work has not been interrupted.', workStopped: false }, { status: 409 })
beforeEach(() => { request.mockReset() })
afterEach(cleanup)

describe('pending upload confirmation', () => {
  it('never discards files without confirmation, and cancellation leaves the request declined', async () => {
    request.mockResolvedValueOnce(declined())
    render(<VolumeStopDialog />)
    const result = fetchWithVolumeStopConfirmation('/api/agents/example/stop', { method: 'POST' }, 'Stop')
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('permanently lose files')
    expect(request).toHaveBeenCalledTimes(1)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((await result).status).toBe(409)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('retries only the confirmed operation with an explicit force flag', async () => {
    request.mockResolvedValueOnce(declined()).mockResolvedValueOnce(Response.json({ success: true }))
    render(<VolumeStopDialog />)
    const result = fetchWithVolumeStopConfirmation('/api/agents/example/mounts/m1?restart=true', { method: 'DELETE' }, 'Remove volume')
    await userEvent.click(await screen.findByRole('button', { name: 'Remove volume anyway' }))
    expect((await result).ok).toBe(true)
    expect(request).toHaveBeenLastCalledWith('/api/agents/example/mounts/m1?restart=true&force=true', { method: 'DELETE' })
  })

  it('requires a separate decision for each concurrent operation', async () => {
    request.mockImplementation(async path => path.includes('force=true') ? Response.json({ success: true }) : declined())
    render(<VolumeStopDialog />)
    const first = fetchWithVolumeStopConfirmation('/api/agents/first/stop', { method: 'POST' }, 'Stop')
    const second = fetchWithVolumeStopConfirmation('/api/agents/second', { method: 'DELETE' }, 'Delete')
    await userEvent.click(await screen.findByRole('button', { name: 'Stop anyway' }))
    expect((await first).ok).toBe(true)
    expect(await screen.findByRole('button', { name: 'Delete anyway' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect((await second).status).toBe(409)
    expect(request.mock.calls.filter(([path]) => path.includes('force=true'))).toHaveLength(1)
  })

  it('does not offer an override for unrelated conflicts', async () => {
    request.mockResolvedValueOnce(Response.json({ error: 'Permission conflict' }, { status: 409 }))
    render(<VolumeStopDialog />)
    expect((await fetchWithVolumeStopConfirmation('/api/agents/example', { method: 'DELETE' }, 'Delete')).status).toBe(409)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })
})
