import { useCallback, useState } from 'react'
import type { ReferenceAttachment } from '@renderer/components/messages/attachment-preview'
import { useFilePreview } from '@renderer/context/file-preview-context'
import type { TeamBrainNode } from '@renderer/lib/team-brain/team-brain-structure'
import { mountPathOf } from '@shared/lib/volumes/base-mountable-volume'
import { CHIP_MARKER } from '@renderer/lib/chip-marker'

/** A path the message carries as written: on one line, not read as a composer chip, and not trimmed away at its end. */
const carriesAsWritten = (path: string) => !/[\r\n\u2028\u2029]/.test(path) && !/\s$/.test(path) && path.search(CHIP_MARKER) === -1

type TeamBrainFocus = { id: string; name: string; kind: 'file' | 'folder' }

/**
 * The card the composer shows for what is in focus: the path the Team Brain agent reads it at, in its drive. None for a
 * path the message would not carry as written.
 */
export function referenceFor(focus: TeamBrainFocus, drive: string): ReferenceAttachment | null {
  const path = `${mountPathOf(drive)}/${focus.kind === 'file' ? focus.id : `${focus.id}/`}`
  if (!carriesAsWritten(path)) return null
  return { type: 'reference', id: `team-brain:${focus.id}`, name: focus.name, path, kind: focus.kind, from: 'Team Brain' }
}

/**
 * What the person is looking at on Team Brain's page, as a card for the next message: the page in the drawer's tab
 * when the tree opened it there, else the folder the tree has chosen. ✕ sets it aside until it is chosen again.
 */
export function useTeamBrainFocus(drive: string | undefined) {
  const { openTabs, activeTabIndex, isOpen } = useFilePreview()
  // Pages by their tab, as the tree opened them: a tab keeps its page when the tree no longer shows it.
  const [pages, setPages] = useState<ReadonlyMap<string, TeamBrainNode>>(() => new Map())
  const [folder, setFolder] = useState<{ id: string; name: string } | null>(null)
  // A page and a folder are set aside apart, so setting one aside never brings the other back.
  const [dismissedPage, setDismissedPage] = useState<string | null>(null)
  const [dismissedFolder, setDismissedFolder] = useState<string | null>(null)

  const active = isOpen ? openTabs[activeTabIndex] : undefined
  const tab = active?.kind === 'file' ? active.filePath : undefined
  const page = tab ? pages.get(tab) : undefined
  const pageTab = page ? tab! : null
  const folderId = page ? null : folder?.id ?? null
  const focus: TeamBrainFocus | null = page ? { id: page.id, name: page.name, kind: 'file' } : folder && { ...folder, kind: 'folder' }
  // A page set aside stays aside only while its tab is the one shown.
  const [shownTab, setShownTab] = useState(tab)
  if (tab !== shownTab) {
    setShownTab(tab)
    setDismissedPage(null)
  }
  const setAside = pageTab ? pageTab === dismissedPage : folderId === dismissedFolder
  const reference = focus && drive && !setAside ? referenceFor(focus, drive) : null

  const pageOpened = useCallback((tab: string, node: TeamBrainNode) => {
    setPages((current) => new Map(current).set(tab, node))
    setDismissedPage((current) => (current === tab ? null : current))
  }, [])
  const folderChosen = useCallback((chosen: { id: string; name: string } | null) => {
    setFolder(chosen)
    if (chosen) setDismissedFolder((current) => (current === chosen.id ? null : current))
  }, [])
  const dismiss = useCallback(() => {
    if (pageTab) setDismissedPage(pageTab)
    else if (folderId) setDismissedFolder(folderId)
  }, [pageTab, folderId])

  return { reference, folder: folder?.id ?? null, pageOpened, folderChosen, dismiss }
}
