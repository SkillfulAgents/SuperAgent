// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore, type DraftsStore } from '@renderer/context/drafts-context'
import {
  PENDING_ATTACHMENT_DROP_TTL_MS,
  setPendingAttachmentDrop,
  usePendingAttachmentDrop,
} from './pending-attachment-drop'
import type { DataTransferResult } from './file-utils'

function wrapper({ children }: { children: ReactNode }) {
  return <DraftsProvider>{children}</DraftsProvider>
}

describe('pending attachment drops', () => {
  it('holds the drop in the composer draft without disturbing the rest of it', () => {
    let store: DraftsStore | undefined
    renderHook(() => { store = useDraftsStore() }, { wrapper })
    act(() => {
      store!.update('session:session-1', { text: 'typed' })
      setPendingAttachmentDrop(store!, 'session:session-1', { files: [], folders: [] })
    })
    expect(store!.get('session:session-1')).toEqual({
      text: 'typed',
      pendingDrop: { items: { files: [], folders: [] }, droppedAt: expect.any(Number) },
    })
  })

  it('reactively drains a drop exactly once', async () => {
    const addItems = vi.fn()
    let store: DraftsStore | undefined
    const draftKey = 'session:session-1'
    const dropped: DataTransferResult = {
      files: [{ file: new File(['hello'], 'hello.txt', { type: 'text/plain' }) }],
      folders: [],
    }

    renderHook(() => {
      store = useDraftsStore()
      usePendingAttachmentDrop(draftKey, addItems)
    }, { wrapper })

    act(() => setPendingAttachmentDrop(store!, draftKey, dropped))

    await waitFor(() => expect(addItems).toHaveBeenCalledWith(dropped))
    expect(store!.get(draftKey)).toBeUndefined()

    await act(async () => {})
    expect(addItems).toHaveBeenCalledTimes(1)
  })

  it('discards a drop whose composer never mounted in time', async () => {
    const addItems = vi.fn()
    let store: DraftsStore | undefined
    const draftKey = 'session:session-1'

    // A drop written before the composer existed — e.g. the target route errored
    // out, or the user navigated away again — must not attach itself on a later,
    // unrelated visit. `null` stands in for "no composer mounted yet".
    const { rerender } = renderHook(({ key }: { key: string | null }) => {
      store = useDraftsStore()
      usePendingAttachmentDrop(key, addItems)
    }, { wrapper, initialProps: { key: null as string | null } })

    act(() => setPendingAttachmentDrop(store!, draftKey, { files: [], folders: [] }))
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + PENDING_ATTACHMENT_DROP_TTL_MS + 1)

    rerender({ key: draftKey })
    await act(async () => {})
    expect(addItems).not.toHaveBeenCalled()
    expect(store!.get(draftKey)).toBeUndefined()
    vi.restoreAllMocks()
  })
})
