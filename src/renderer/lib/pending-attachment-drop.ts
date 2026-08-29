import { useEffect, useRef } from 'react'
import { useDraftsStore } from '@renderer/context/drafts-context'
import type { DataTransferResult } from './file-utils'

export const pendingAttachmentDropKey = (draftKey: string) =>
  `pending-attachment-drop:${draftKey}`

export function usePendingAttachmentDrop(
  draftKey: string | null | undefined,
  addItems: (items: DataTransferResult) => void,
): void {
  const store = useDraftsStore()
  const addItemsRef = useRef(addItems)
  addItemsRef.current = addItems
  const key = draftKey ? pendingAttachmentDropKey(draftKey) : undefined

  useEffect(() => {
    if (!key) return

    const drain = () => {
      const pending = store.get<DataTransferResult>(key)
      if (!pending) return
      store.set(key, undefined)
      addItemsRef.current(pending)
    }

    drain()
    return store.subscribe(key, drain)
  }, [key, store])
}
