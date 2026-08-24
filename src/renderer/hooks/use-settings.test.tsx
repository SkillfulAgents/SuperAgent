// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { HttpError } from '@renderer/lib/api'
import { useSettings, useStartRunner, useRestartRunner, RunnerSetupFailedError } from './use-settings'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'

const apiFetchMock = vi.fn()

vi.mock('@renderer/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/api')>()),
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function makeWrapper(queries: { retry?: boolean | number } = { retry: false }) {
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: 0, retryDelay: 0, ...queries }, mutations: { retry: false } },
  })
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return makeWrapper()({ children })
}

const setupPayload: RunnerSetupRemediation = {
  kind: 'virt-disabled-in-bios',
  title: 'Virtualization is disabled in BIOS',
  remediation: 'Enable VT-x in BIOS.',
  steps: [{ label: 'Reboot and enter BIOS' }],
  docsUrl: 'https://aka.ms/enablevirtualization',
  originalStderr: 'HCS_E_HYPERV_NOT_INSTALLED',
  userResolvable: true,
}

describe('useSettings', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('does not retry a 403', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 403 })

    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper({ retry: 3 }) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(HttpError)
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a 401', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 401 })

    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper({ retry: 3 }) })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(apiFetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not fetch when disabled', () => {
    const { result } = renderHook(() => useSettings({ enabled: false }), { wrapper: makeWrapper() })

    expect(result.current.fetchStatus).toBe('idle')
    expect(apiFetchMock).not.toHaveBeenCalled()
  })
})

describe('useStartRunner', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('throws RunnerSetupFailedError when server returns 400 with setupError', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, message: 'nope', setupError: setupPayload }),
    })

    const { result } = renderHook(() => useStartRunner(), { wrapper })
    result.current.mutate('wsl2')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(RunnerSetupFailedError)
    expect((result.current.error as RunnerSetupFailedError).setupError).toEqual(setupPayload)
  })

  it('throws generic Error when server returns 400 without setupError', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, message: 'Docker not installed' }),
    })

    const { result } = renderHook(() => useStartRunner(), { wrapper })
    result.current.mutate('docker')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.error).not.toBeInstanceOf(RunnerSetupFailedError)
    expect(result.current.error?.message).toBe('Docker not installed')
  })

  it('returns data on success', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, message: 'Runtime is running.' }),
    })

    const { result } = renderHook(() => useStartRunner(), { wrapper })
    result.current.mutate('lima')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.message).toBe('Runtime is running.')
  })
})

describe('useRestartRunner', () => {
  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('throws RunnerSetupFailedError when server returns 400 with setupError', async () => {
    apiFetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ success: false, message: 'nope', setupError: setupPayload }),
    })

    const { result } = renderHook(() => useRestartRunner(), { wrapper })
    result.current.mutate('wsl2')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeInstanceOf(RunnerSetupFailedError)
  })
})
