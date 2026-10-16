import { useCallback, useState } from 'react'

export interface PreviewFileTab {
  kind: 'file'
  filePath: string
  displayName: string
  description?: string
  /**
   * Cache-busting token for this tab's file URL, bumped every time the file is
   * (re)delivered or renamed. Seeded from the clock rather than 0 so a reload
   * never reuses a URL an intermediary may still be serving a stale body for —
   * the agent rewrites these files in place, so path alone is not an identity.
   */
  version: number
  /** 1-based page currently shown when this tab contains a PDF. */
  pdfPage: number
}

export interface PreviewFolderTab {
  kind: 'folder'
  /** A pinned directory remains open when all its file tabs are closed. */
  closable?: boolean
  rootPath: string
  displayName: string
  expandedPaths: string[]
  selectedPath?: string
  query: string
}

export type FileBrowserTab = PreviewFileTab | PreviewFolderTab

/** Paths are scoped to one browser; workspace callers also include the agent. */
export function getFileBrowserTabKey(tab: FileBrowserTab): string {
  return `${tab.kind}:${tab.kind === 'file' ? tab.filePath : tab.rootPath}`
}

let lastFileVersion = 0

/** Strictly increasing, clock-seeded token so reopening never reuses stale bytes. */
export function nextFileVersion(): number {
  lastFileVersion = Math.max(Date.now(), lastFileVersion + 1)
  return lastFileVersion
}

/** Shared tab selection, deduplication, closing and PDF state for both browsers. */
export function useFilePreviewTabs<T extends FileBrowserTab>(
  getKey: (tab: T) => string,
  initialTabs: T[] = [],
) {
  const [openTabs, setOpenTabs] = useState<T[]>(initialTabs)
  const [activeTabIndex, setActiveTabIndex] = useState(0)

  const openTab = useCallback((tab: T, refresh?: (existing: T) => T) => {
    setOpenTabs(current => {
      const index = current.findIndex(existing => getKey(existing) === getKey(tab))
      setActiveTabIndex(index < 0 ? current.length : index)
      if (index < 0) return [...current, tab]
      return refresh ? current.map((existing, i) => i === index ? refresh(existing) : existing) : current
    })
  }, [getKey])

  const closeTab = useCallback((key: string, onClosed?: (tab: T, remaining: T[]) => void) => {
    setOpenTabs(current => {
      const index = current.findIndex(tab => getKey(tab) === key)
      const tab = current[index]
      if (!tab || (tab.kind === 'folder' && tab.closable === false)) return current
      const next = current.filter((_, i) => i !== index)
      setActiveTabIndex(active => Math.max(0, Math.min(active > index ? active - 1 : active, next.length - 1)))
      onClosed?.(tab, next)
      return next
    })
  }, [getKey])

  const setPdfPage = useCallback((key: string, page: number) => {
    const nextPage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1
    setOpenTabs(current => current.map(tab => (
      tab.kind === 'file' && getKey(tab) === key && tab.pdfPage !== nextPage
        ? { ...tab, pdfPage: nextPage } : tab
    )))
  }, [getKey])

  return { openTabs, setOpenTabs, activeTabIndex, setActiveTabIndex, openTab, closeTab, setPdfPage }
}
