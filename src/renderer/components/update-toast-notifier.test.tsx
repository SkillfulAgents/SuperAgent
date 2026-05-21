// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { UpdateToastNotifier } from './update-toast-notifier'
import {
  UpdateStatusProvider,
  type UpdateStatus,
} from '@renderer/context/update-status-context'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const toastMock = vi.fn((..._args: any[]): string | number => 'toast-id-1')
vi.mock('sonner', () => ({
  toast: (...args: any[]) => toastMock(...args),
}))

const downloadUpdate = vi.fn()
const installUpdate = vi.fn()

// Build a controllable electronAPI surface that lets tests push status updates.
function installElectronAPI(initial: UpdateStatus) {
  let listener: ((s: UpdateStatus) => void) | null = null
  ;(window as any).electronAPI = {
    getUpdateStatus: vi.fn(async () => initial),
    onUpdateStatus: vi.fn((cb: (s: UpdateStatus) => void) => {
      listener = cb
      return () => { listener = null }
    }),
    removeUpdateStatus: vi.fn(),
    downloadUpdate,
    installUpdate,
  }
  return {
    push: (s: UpdateStatus) => listener?.(s),
    isSubscribed: () => listener !== null,
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(UpdateStatusProvider, null, children)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UpdateToastNotifier', () => {
  beforeEach(() => {
    toastMock.mockClear()
    toastMock.mockReturnValue('toast-id-1')
    downloadUpdate.mockClear()
    installUpdate.mockClear()
  })

  it('does not toast for the initial idle state', async () => {
    installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })
    expect(toastMock).not.toHaveBeenCalled()
  })

  it('shows a sticky toast with a Download action when an update becomes available', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })

    expect(toastMock).toHaveBeenCalledTimes(1)
    const [message, opts] = toastMock.mock.calls[0] as [string, any]
    expect(message).toContain('1.2.3')
    expect(opts.duration).toBe(Infinity)
    expect(opts.closeButton).toBe(true)
    expect(opts.action.label).toBe('Download')

    // Clicking Download triggers electronAPI.downloadUpdate.
    opts.action.onClick()
    expect(downloadUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not re-toast the same version on repeated available status', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })
    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })

    expect(toastMock).toHaveBeenCalledTimes(1)
  })

  it('updates the existing toast when status transitions to downloading', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })
    await act(async () => { api.push({ state: 'downloading', version: '1.2.3', progress: 42 }) })

    expect(toastMock).toHaveBeenCalledTimes(2)
    const [, opts] = toastMock.mock.calls[1] as [string, any]
    expect(opts.id).toBe('toast-id-1')
    expect(opts.description).toContain('42%')
    // No action while downloading.
    expect(opts.action).toBeUndefined()
  })

  it('switches the action to Restart & Update when downloaded', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })
    await act(async () => { api.push({ state: 'downloaded', version: '1.2.3' }) })

    const [, opts] = toastMock.mock.calls[toastMock.mock.calls.length - 1] as [string, any]
    expect(opts.id).toBe('toast-id-1')
    expect(opts.action.label).toBe('Restart & Update')

    opts.action.onClick()
    expect(installUpdate).toHaveBeenCalledTimes(1)
  })

  it('replaces an undismissed toast when a newer version arrives', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })
    // First toast: no id passed (sonner generates one and we capture it).
    expect((toastMock.mock.calls[0][1] as any).id).toBeUndefined()

    await act(async () => { api.push({ state: 'available', version: '1.2.4' }) })
    // Second toast for the newer version reuses the first toast's id, so
    // sonner replaces the existing toast in place rather than stacking.
    expect(toastMock).toHaveBeenCalledTimes(2)
    expect((toastMock.mock.calls[1][1] as any).id).toBe('toast-id-1')
    expect(toastMock.mock.calls[1][0]).toContain('1.2.4')
  })

  it('creates a fresh toast for a new version after the previous was dismissed', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })
    // User dismisses.
    ;(toastMock.mock.calls[0][1] as any).onDismiss()

    await act(async () => { api.push({ state: 'available', version: '1.2.4' }) })
    // Second toast is a fresh one (no id reused) since the previous slot
    // was dismissed and the ref cleared.
    expect(toastMock).toHaveBeenCalledTimes(2)
    expect((toastMock.mock.calls[1][1] as any).id).toBeUndefined()
  })

  it('stays silent after the user dismisses the toast', async () => {
    const api = installElectronAPI({ state: 'idle' })
    await act(async () => {
      render(createElement(wrapper, null, createElement(UpdateToastNotifier)))
    })

    await act(async () => { api.push({ state: 'available', version: '1.2.3' }) })

    // Simulate user closing the toast.
    const [, opts] = toastMock.mock.calls[0] as [string, any]
    opts.onDismiss()

    await act(async () => { api.push({ state: 'downloading', version: '1.2.3', progress: 30 }) })
    await act(async () => { api.push({ state: 'downloaded', version: '1.2.3' }) })

    // No further toast() calls after dismiss.
    expect(toastMock).toHaveBeenCalledTimes(1)
  })
})

describe('UpdateStatusProvider', () => {
  it('subscribes via the per-listener unsubscribe and calls it on unmount', async () => {
    const api = installElectronAPI({ state: 'idle' })
    let unmount: () => void = () => {}
    await act(async () => {
      const result = render(createElement(wrapper, null, createElement('div')))
      unmount = result.unmount
    })
    expect(api.isSubscribed()).toBe(true)

    unmount()
    expect(api.isSubscribed()).toBe(false)
  })
})
