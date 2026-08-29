// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { DraftsProvider, useDraftsStore, type DraftsStore } from '@renderer/context/drafts-context'
import { pendingAttachmentDropKey, usePendingAttachmentDrop } from './pending-attachment-drop'
import type { DataTransferResult } from './file-utils'

function wrapper({ children }: { children: ReactNode }) {
  return <DraftsProvider>{children}</DraftsProvider>
}

describe('pending attachment drops', () => {
  it('namespaces drops by composer draft key', () => {
    expect(pendingAttachmentDropKey('agent:agent-1')).toBe('pending-attachment-drop:agent:agent-1')
    expect(pendingAttachmentDropKey('session:session-1')).toBe('pending-attachment-drop:session:session-1')
  })

  it('reactively drains a drop exactly once', async () => {
    const addItems = vi.fn()
    let store: DraftsStore | undefined
    const draftKey = 'session:session-1'
    const key = pendingAttachmentDropKey(draftKey)
    const dropped: DataTransferResult = {
      files: [{ file: new File(['hello'], 'hello.txt', { type: 'text/plain' }) }],
      folders: [],
    }

    renderHook(() => {
      store = useDraftsStore()
      usePendingAttachmentDrop(draftKey, addItems)
    }, { wrapper })

    act(() => store!.set(key, dropped))

    await waitFor(() => expect(addItems).toHaveBeenCalledWith(dropped))
    expect(store!.get(key)).toBeUndefined()

    await act(async () => {})
    expect(addItems).toHaveBeenCalledTimes(1)
  })
})
