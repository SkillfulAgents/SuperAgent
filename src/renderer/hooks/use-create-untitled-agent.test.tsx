// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const { mockMutateAsync, mockUpdateMutateAsync, mockNavigate, mockTrack, mockSetJustCreatedSlug, mockHold } =
  vi.hoisted(() => ({
    mockMutateAsync: vi.fn(),
    mockUpdateMutateAsync: vi.fn(),
    mockNavigate: vi.fn(),
    mockTrack: vi.fn(),
    mockSetJustCreatedSlug: vi.fn(),
    mockHold: vi.fn(),
  }))

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUpdateUserSettings: () => ({ mutateAsync: mockUpdateMutateAsync, isPending: false }),
}))
vi.mock('@renderer/lib/api', () => ({ holdAgentRequestsUntilCreated: mockHold }))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))
vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({ setJustCreatedSlug: mockSetJustCreatedSlug }),
}))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mockTrack }),
}))
vi.mock('@shared/lib/utils/agent-id', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shared/lib/utils/agent-id')>(),
  randomAgentId: () => 'k3v9qm2x7a',
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import type { ApiAgent } from '@shared/lib/types/api'
import { useCreateUntitledAgent } from './use-create-untitled-agent'

const ID = 'k3v9qm2x7a'
const DISPLAY_SLUG = `untitled-${ID}`
const EXISTING: ApiAgent = { slug: 'sales00agnt', displaySlug: 'sales-sales00agnt', name: 'Sales', createdAt: new Date(0), status: 'stopped', containerPort: null }

let queryClient: QueryClient

function render() {
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: queryClient }, children)
  return renderHook(() => useCreateUntitledAgent(), { wrapper })
}

/** The create, held open until the test answers it. */
function heldCreate() {
  let answer!: (agent: ApiAgent) => void
  let fail!: (error: Error) => void
  mockMutateAsync.mockReturnValueOnce(new Promise<ApiAgent>((resolve, reject) => { answer = resolve; fail = reject }))
  return { answer: (agent: ApiAgent) => answer(agent), fail: (error: Error) => fail(error) }
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient = new QueryClient()
  queryClient.setQueryData(['agents'], [EXISTING])
  mockMutateAsync.mockImplementation(async (input: { name: string; id: string; avatar: ApiAgent['avatar'] }) => ({
    slug: input.id, displaySlug: DISPLAY_SLUG, name: input.name, avatar: input.avatar, createdAt: new Date(), status: 'stopped', containerPort: null,
  }))
  mockUpdateMutateAsync.mockResolvedValue({})
})

describe('useCreateUntitledAgent', () => {
  it('opens the new agent before its create answers', async () => {
    const create = heldCreate()
    const { result } = render()
    let creation!: Promise<unknown>
    await act(async () => {
      creation = result.current.createUntitledAgent({ surface: 'nav' })
    })

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/agents/$slug', params: { slug: DISPLAY_SLUG } })
    expect(mockSetJustCreatedSlug).toHaveBeenCalledWith(ID)
    const shown = queryClient.getQueryData<ApiAgent>(['agents', DISPLAY_SLUG])
    expect(shown).toMatchObject({ slug: ID, name: 'Untitled', status: 'stopped' })
    expect(queryClient.getQueryData<ApiAgent>(['agents', ID])).toBe(shown)
    expect(queryClient.getQueryData<ApiAgent[]>(['agents'])?.map((agent) => agent.slug)).toEqual([ID, EXISTING.slug])

    await act(async () => {
      create.answer({ ...shown!, createdAt: new Date() })
      await creation
    })
    expect(mockTrack).toHaveBeenCalledWith('agent_created', expect.objectContaining({ source: 'new', surface: 'nav' }))
  })

  it('creates the agent with the id and avatar it showed, and holds requests about it until then', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.createUntitledAgent({ surface: 'nav' })
    })

    const shown = queryClient.getQueryData<ApiAgent>(['agents', ID])
    expect(mockMutateAsync).toHaveBeenCalledWith({ name: 'Untitled', id: ID, avatar: shown?.avatar })
    expect(shown?.avatar).toEqual({ color: expect.any(String), shape: expect.any(String) })
    expect(mockHold).toHaveBeenCalledWith(ID, mockMutateAsync.mock.results[0].value)
    expect(mockHold.mock.invocationCallOrder[0]).toBeLessThan(mockNavigate.mock.invocationCallOrder[0])
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled()
  })

  it('takes the agent away and goes home when its create fails', async () => {
    const create = heldCreate()
    const { result } = render()
    let creation!: Promise<unknown>
    await act(async () => {
      creation = result.current.createUntitledAgent({ surface: 'section_plus', folderId: 'f1' })
    })

    await act(async () => {
      create.fail(new Error('Agent limit reached'))
      expect(await creation).toBeNull()
    })
    expect(queryClient.getQueryData(['agents', ID])).toBeUndefined()
    expect(queryClient.getQueryData(['agents', DISPLAY_SLUG])).toBeUndefined()
    expect(toast.error).toHaveBeenCalledWith('Failed to create agent', { description: 'Agent limit reached' })
    expect(mockNavigate).toHaveBeenLastCalledWith({ to: '/' })
    expect(mockTrack).not.toHaveBeenCalled()
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled()
  })

  it('files the new agent into the requested folder once it exists', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.createUntitledAgent({ surface: 'section_plus', folderId: 'f1' })
    })

    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
    expect(mockMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMutateAsync.mock.invocationCallOrder[0])
    // Updater form, resolved against the settings as of when the serialized
    // write runs — it must keep whatever assignments landed in the meantime.
    const patch = mockUpdateMutateAsync.mock.calls[0][0]
    expect(patch({ agentFolderAssignments: { other: 'f2' } })).toEqual({
      agentFolderAssignments: { other: 'f2', [ID]: 'f1' },
    })
  })

  it('keeps the created agent open and explains a failed filing without creating twice', async () => {
    mockUpdateMutateAsync.mockRejectedValueOnce(new Error('offline'))
    const { result } = render()
    await act(async () => {
      expect(await result.current.createUntitledAgent({ surface: 'section_plus', folderId: 'f1' })).toMatchObject({ slug: ID })
    })
    expect(mockMutateAsync).toHaveBeenCalledOnce()
    expect(mockNavigate).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(
      'Agent created, but could not add it to the section',
      expect.objectContaining({ description: expect.stringContaining('Your Agents') }),
    )
  })

  it('treats the default folder as unfiled', async () => {
    const { result } = render()
    await act(async () => {
      await result.current.createUntitledAgent({ surface: 'section_plus', folderId: 'root' })
    })
    const patch = mockUpdateMutateAsync.mock.calls[0][0]
    expect(patch({ agentFolderAssignments: { [ID]: 'f1' } })).toEqual({
      agentFolderAssignments: {},
    })
  })
})
