import { useCallback, type DragEventHandler } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { getItemsFromDataTransfer } from '@renderer/lib/file-utils'
import { pendingAttachmentDropKey } from '@renderer/lib/pending-attachment-drop'

type SidebarFileDropTarget =
  | { kind: 'agent'; agentSlug: string; displaySlug: string }
  | { kind: 'session'; agentSlug: string; sessionId: string }

function containsFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.types.includes('Files')
}

function setFileDropActive(element: HTMLElement, active: boolean): void {
  element.toggleAttribute('data-file-drop-active', active)
}

export function useSidebarFileDrop(target: SidebarFileDropTarget): {
  onDragEnter: DragEventHandler<HTMLElement>
  onDragOver: DragEventHandler<HTMLElement>
  onDragLeave: DragEventHandler<HTMLElement>
  onDrop: DragEventHandler<HTMLElement>
} {
  const navigate = useNavigate()
  const store = useDraftsStore()

  const handleDragEnter = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setFileDropActive(event.currentTarget, true)
  }, [])

  const handleDragOver = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const handleDragLeave = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFileDropActive(event.currentTarget, false)
    }
  }, [])

  const handleDrop = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    setFileDropActive(event.currentTarget, false)

    void getItemsFromDataTransfer(event.dataTransfer).then((items) => {
      if (items.files.length === 0 && items.folders.length === 0) return

      if (target.kind === 'agent') {
        store.set(pendingAttachmentDropKey(`agent:${target.agentSlug}`), items)
        void navigate({ to: '/agents/$slug', params: { slug: target.displaySlug } })
        return
      }

      store.set(pendingAttachmentDropKey(`session:${target.sessionId}`), items)
      void navigate({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: target.agentSlug, sessionId: target.sessionId },
      })
    })
  }, [target, store, navigate])

  return {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  }
}
