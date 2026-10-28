import { useCallback, type DragEventHandler } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { useDraftsStore } from '@renderer/context/drafts-context'
import { getItemsFromDataTransfer } from '@renderer/lib/file-utils'
import { setPendingAttachmentDrop } from '@renderer/lib/pending-attachment-drop'

type SidebarFileDropTarget = (
  | { kind: 'agent'; agentSlug: string; displaySlug: string }
  | { kind: 'session'; agentSlug: string; sessionId: string }
) & {
  /**
   * Refuse drops (no cue, "not allowed" cursor, explanatory toast). Set for
   * sessions awaiting input: those render the pending-request stack instead of
   * the composer, so there is nothing mounted to receive the attachment.
   */
  disabled?: boolean
}

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
  // Callers pass `target` as an object literal, so depend on its fields instead —
  // an unstable object dep would rebuild every handler on every sidebar render.
  const { kind, agentSlug, disabled = false } = target
  const displaySlug = target.kind === 'agent' ? target.displaySlug : undefined
  const sessionId = target.kind === 'session' ? target.sessionId : undefined

  const handleDragEnter = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    if (disabled) return
    setFileDropActive(event.currentTarget, true)
  }, [disabled])

  const handleDragOver = useCallback<DragEventHandler<HTMLElement>>((event) => {
    if (!containsFiles(event.dataTransfer)) return
    // Claim the event either way: without preventDefault the browser handles the
    // drop itself and navigates the window to the dropped file.
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'
  }, [disabled])

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

    if (disabled) {
      toast.error("Can't attach files while this session is awaiting a reply", {
        description: 'Answer the pending request first, then drop the files.',
      })
      return
    }

    getItemsFromDataTransfer(event.dataTransfer).then((items) => {
      if (items.files.length === 0 && items.folders.length === 0) return

      if (kind === 'agent') {
        setPendingAttachmentDrop(store, `agent:${agentSlug}`, items)
        void navigate({ to: '/agents/$slug', params: { slug: displaySlug! } })
        return
      }

      setPendingAttachmentDrop(store, `session:${sessionId}`, items)
      void navigate({
        to: '/agents/$slug/sessions/$sessionId',
        params: { slug: agentSlug, sessionId: sessionId! },
      })
    }).catch(() => {
      // Reading a dropped directory can fail (unreadable entry, file removed
      // mid-drag). The cue is already cleared, so say so rather than vanishing.
      toast.error("Couldn't read the dropped files")
    })
  }, [kind, agentSlug, displaySlug, sessionId, disabled, store, navigate])

  return {
    onDragEnter: handleDragEnter,
    onDragOver: handleDragOver,
    onDragLeave: handleDragLeave,
    onDrop: handleDrop,
  }
}
