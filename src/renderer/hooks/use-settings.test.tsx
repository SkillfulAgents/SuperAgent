// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useStartRunner, useRestartRunner, useModelSettings, RunnerSetupFailedError } from './use-settings'
import type { RunnerSetupRemediation } from '@shared/lib/container/wsl2-setup-errors'

const apiFetchMock = vi.fn()

vi.mock('@renderer/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
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

describe('useModelSettings', () => {
  type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  // A fresh object per read, like a real body: the hook writes into it.
  const respond = (body: unknown, ok = true) => ({ ok, json: async () => JSON.parse(JSON.stringify(body)) })
  const settings = { models: { agentModel: 'sonnet' } }
  const connectionsPath = '/api/agents/my%20agent/llm-connections?llmProviderId=saved%2Fid'

  // Every request stays in flight until the test answers it. The hook gets a
  // plain thenable because vi.fn() handles any Promise it returns, which
  // would hide a rejection the hook leaves unhandled.
  function holdRequests() {
    const pending = new Map<string, Pending>()
    apiFetchMock.mockImplementation((url: string) => {
      const request = new Promise((resolve, reject) => { pending.set(url, { resolve, reject }) })
      return { then: request.then.bind(request), catch: request.catch.bind(request) }
    })
    return pending
  }

  beforeEach(() => {
    apiFetchMock.mockReset()
  })

  it('starts the saved-connection read before the settings read answers', async () => {
    const pending = holdRequests()
    const { result } = renderHook(() => useModelSettings('my agent', 'saved/id'), { wrapper })

    await waitFor(() => expect([...pending.keys()]).toEqual(['/api/settings/models', connectionsPath]))
    pending.get(connectionsPath)?.resolve(respond({ connections: [{ id: 'saved/id' }] }))
    pending.get('/api/settings/models')?.resolve(respond(settings))

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ ...settings, connections: [{ id: 'saved/id' }] })
  })

  it('reads only the settings without an agent', async () => {
    apiFetchMock.mockResolvedValue(respond(settings))
    const { result } = renderHook(() => useModelSettings(), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(apiFetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/settings/models'])
    expect(result.current.data).toEqual(settings)
  })

  it('reports a failed settings read even when the connection read failed first', async () => {
    const pending = holdRequests()
    const { result } = renderHook(() => useModelSettings('my agent', 'saved/id'), { wrapper })

    await waitFor(() => expect(pending.size).toBe(2))
    pending.get(connectionsPath)?.reject(new TypeError('Failed to fetch'))
    pending.get('/api/settings/models')?.resolve(respond({}, false))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to fetch model settings')
  })

  it('does not leave the abandoned connection read unhandled when the settings read fails', async () => {
    const pending = holdRequests()
    const { result } = renderHook(() => useModelSettings('my agent', 'saved/id'), { wrapper })

    await waitFor(() => expect(pending.size).toBe(2))
    pending.get('/api/settings/models')?.resolve(respond({}, false))
    await waitFor(() => expect(result.current.isError).toBe(true))
    pending.get(connectionsPath)?.reject(new TypeError('Failed to fetch'))
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(result.current.error?.message).toBe('Failed to fetch model settings')
  })

  it('fails without partial data when only the connection read fails', async () => {
    apiFetchMock.mockImplementation(async (url: string) => (
      url === '/api/settings/models' ? respond(settings) : respond({}, false)
    ))
    const { result } = renderHook(() => useModelSettings('my agent'), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('Failed to fetch saved model connection')
    expect(result.current.data).toBeUndefined()
  })
})
