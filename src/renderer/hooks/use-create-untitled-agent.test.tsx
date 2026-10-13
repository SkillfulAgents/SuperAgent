// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const { mockMutateAsync, mockUpdateMutateAsync, mockNavigate, mockTrack, mockSetJustCreatedSlug } =
  vi.hoisted(() => ({
    mockMutateAsync: vi.fn(),
    mockUpdateMutateAsync: vi.fn(),
    mockNavigate: vi.fn(),
    mockTrack: vi.fn(),
    mockSetJustCreatedSlug: vi.fn(),
  }))

vi.mock('@renderer/hooks/use-agents', () => ({
  useCreateAgent: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
}))
vi.mock('@renderer/hooks/use-user-settings', () => ({
  useUpdateUserSettings: () => ({ mutateAsync: mockUpdateMutateAsync, isPending: false }),
}))
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}))
vi.mock('@renderer/context/nav-transient-context', () => ({
  useNavTransient: () => ({ setJustCreatedSlug: mockSetJustCreatedSlug }),
}))
vi.mock('@renderer/context/analytics-context', () => ({
  useAnalyticsTracking: () => ({ track: mockTrack }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { toast } from 'sonner'
import { useCreateUntitledAgent } from './use-create-untitled-agent'

const AGENT = { slug: 'untitled-abc', displaySlug: 'untitled' }

beforeEach(() => {
  vi.clearAllMocks()
  mockMutateAsync.mockResolvedValue(AGENT)
  mockUpdateMutateAsync.mockResolvedValue({})
})

describe('useCreateUntitledAgent', () => {
  it('creates and navigates without touching folders by default', async () => {
    const { result } = renderHook(() => useCreateUntitledAgent())
    await act(async () => {
      await result.current.createUntitledAgent()
    })
    expect(mockMutateAsync).toHaveBeenCalledWith({ name: 'Untitled' })
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/agents/$slug',
      params: { slug: 'untitled' },
    })
  })

  it('files the new agent into the requested folder before navigating', async () => {
    const { result } = renderHook(() => useCreateUntitledAgent())
    await act(async () => {
      await result.current.createUntitledAgent({ folderId: 'f1' })
    })

    expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
    expect(mockUpdateMutateAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockNavigate.mock.invocationCallOrder[0]
    )
    // Updater form, resolved against the settings as of when the serialized
    // write runs — it must keep whatever assignments landed in the meantime.
    const patch = mockUpdateMutateAsync.mock.calls[0][0]
    expect(patch({ agentFolderAssignments: { other: 'f2' } })).toEqual({
      agentFolderAssignments: { other: 'f2', 'untitled-abc': 'f1' },
    })
  })

  it('waits for the assignment to finish before navigating', async () => {
    let finish!: () => void
    mockUpdateMutateAsync.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve }))
    const { result } = renderHook(() => useCreateUntitledAgent())
    let creation!: ReturnType<typeof result.current.createUntitledAgent>
    await act(async () => {
      creation = result.current.createUntitledAgent({ folderId: 'f1' })
    })
    expect(mockUpdateMutateAsync).toHaveBeenCalledOnce()
    expect(mockNavigate).not.toHaveBeenCalled()
    await act(async () => {
      finish()
      await creation
    })
    expect(mockNavigate).toHaveBeenCalledOnce()
  })

  it('opens the created agent and explains a failed assignment without creating twice', async () => {
    mockUpdateMutateAsync.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useCreateUntitledAgent())
    await act(async () => {
      expect(await result.current.createUntitledAgent({ folderId: 'f1' })).toEqual(AGENT)
    })
    expect(mockMutateAsync).toHaveBeenCalledOnce()
    expect(mockNavigate).toHaveBeenCalledOnce()
    expect(toast.error).toHaveBeenCalledWith(
      'Agent created, but could not add it to the section',
      expect.objectContaining({ description: expect.stringContaining('Your Agents') }),
    )
  })

  it('treats the default folder as unfiled', async () => {
    const { result } = renderHook(() => useCreateUntitledAgent())
    await act(async () => {
      await result.current.createUntitledAgent({ folderId: 'root' })
    })
    const patch = mockUpdateMutateAsync.mock.calls[0][0]
    expect(patch({ agentFolderAssignments: { 'untitled-abc': 'f1' } })).toEqual({
      agentFolderAssignments: {},
    })
  })

  it('does not write a filing when creation fails', async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error('nope'))
    const { result } = renderHook(() => useCreateUntitledAgent())
    let agent: unknown
    await act(async () => {
      agent = await result.current.createUntitledAgent({ folderId: 'f1' })
    })
    expect(agent).toBeNull()
    expect(mockUpdateMutateAsync).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
