import { useEffect, useRef } from 'react'
import { useDraftsStore, type DraftsStore } from '@renderer/context/drafts-context'
import type { DataTransferResult } from './file-utils'

/**
 * How long a sidebar drop waits for its composer to mount. The composer normally
 * mounts a frame after the navigation, so anything older than this means it never
 * rendered at all (route error, user navigated away again). Discarding those keeps
 * live File handles out of the app-lifetime drafts store and stops a forgotten drop
 * from suddenly attaching itself on an unrelated later visit.
 */
export const PENDING_ATTACHMENT_DROP_TTL_MS = 30_000

/** Hand a drop to the composer owning `draftKey`, to drain when it next mounts. */
export function setPendingAttachmentDrop(
  store: Pick<DraftsStore, 'update'>,
  draftKey: string,
  items: DataTransferResult,
): void {
  store.update(draftKey, { pendingDrop: { items, droppedAt: Date.now() } })
}

export function usePendingAttachmentDrop(
  draftKey: string | null | undefined,
  addItems: (items: DataTransferResult) => void,
): void {
  const store = useDraftsStore()
  const addItemsRef = useRef(addItems)
  addItemsRef.current = addItems

  useEffect(() => {
    if (!draftKey) return

    const drain = () => {
      const pending = store.get(draftKey)?.pendingDrop
      if (!pending) return
      store.update(draftKey, { pendingDrop: undefined })
      if (Date.now() - pending.droppedAt > PENDING_ATTACHMENT_DROP_TTL_MS) return
      addItemsRef.current(pending.items)
    }

    drain()
    return store.subscribe(draftKey, drain)
  }, [draftKey, store])
}
