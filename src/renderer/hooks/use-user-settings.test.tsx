// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useUpdateUserSettings, type UserSettingsData } from './use-user-settings'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('@renderer/lib/api', () => ({ apiFetch: mockApiFetch }))

const SERVER_SETTINGS = {
  theme: 'dark',
  agentFolders: [{ id: 'f1', name: 'Work' }],
  agentFolderAssignments: { support: 'f1' },
} as unknown as UserSettingsData

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body }
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useUpdateUserSettings(), { wrapper })
  return { queryClient, mutation: result }
}

const putCalls = () =>
  mockApiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
const getCalls = () =>
  mockApiFetch.mock.calls.filter(([, init]) => !(init as RequestInit | undefined)?.method)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useUpdateUserSettings with a functional patch', () => {
  it('fetches the settings first when the cache is empty, and builds the write from them', async () => {
    // The updater form exists to derive whole-field replacements from current
    // settings. Before the first GET settles the cache is empty; an updater
    // fed nothing would rebuild those fields from scratch and erase every
    // stored filing the moment the write lands.
    mockApiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ ...SERVER_SETTINGS })
        : jsonResponse(SERVER_SETTINGS)
    )
    const { mutation } = setup()

    await mutation.current.mutateAsync((current) => ({
      agentFolderAssignments: { ...current.agentFolderAssignments, sales: 'f1' },
    }))

    expect(getCalls()).toHaveLength(1)
    const body = JSON.parse(putCalls()[0][1].body as string)
    expect(body.agentFolderAssignments).toEqual({ support: 'f1', sales: 'f1' })
  })

  it('uses the cache without a fetch when it is already populated', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ...SERVER_SETTINGS }))
    const { queryClient, mutation } = setup()
    queryClient.setQueryData(['user-settings'], SERVER_SETTINGS)

    await mutation.current.mutateAsync((current) => ({
      agentFolderAssignments: { ...current.agentFolderAssignments, sales: 'f1' },
    }))

    expect(getCalls()).toHaveLength(0)
    const body = JSON.parse(putCalls()[0][1].body as string)
    expect(body.agentFolderAssignments).toEqual({ support: 'f1', sales: 'f1' })
  })

  it('fails the mutation instead of writing when the settings cannot be loaded', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ error: 'nope' }, false))
    const { mutation } = setup()

    await expect(
      mutation.current.mutateAsync(() => ({ agentFolderAssignments: {} }))
    ).rejects.toThrow()

    expect(putCalls()).toHaveLength(0)
  })

  it('sends a plain-object patch as-is without touching the settings query', async () => {
    mockApiFetch.mockResolvedValue(jsonResponse({ ...SERVER_SETTINGS }))
    const { mutation } = setup()

    await mutation.current.mutateAsync({ theme: 'light' })

    expect(getCalls()).toHaveLength(0)
    expect(JSON.parse(putCalls()[0][1].body as string)).toEqual({ theme: 'light' })
  })
})
