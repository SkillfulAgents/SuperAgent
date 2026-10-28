import type { ComponentProps } from 'react'
import { FilePreviewProvider } from '@renderer/context/file-preview-context'
import { getFileBrowserTabKey, nextFileVersion, useFilePreviewTabs, type FileBrowserTab } from '@renderer/hooks/use-file-preview-tabs'
import { DirectoryBrowser } from './directory-browser'
import { TabbedFilePreview } from './tabbed-file-preview'

/** Where an open file's bytes are, or why it cannot be shown. */
export type OpenedFile = { inlineUrl: string; downloadUrl?: string } | { reason: string }

/** A folder of files the browser can list and open: a mounted volume, or a zip. */
export interface FileSource {
  useEntries: ComponentProps<typeof DirectoryBrowser>['useEntries']
  /** The open file, or null while it is not ready or no file is open. */
  useFile: (path: string | null, version: number) => OpenedFile | null
}

const directoryTab: FileBrowserTab = { kind: 'folder', rootPath: '', displayName: 'Files', closable: false, expandedPaths: [], query: '' }

/** Browses a source in its own tabs, with comments off: what it shows is not the agent's workspace. */
export function FileBrowser({ source }: { source: FileSource }) {
  return <FilePreviewProvider commentsEnabled={false} sessionId={null}>
    <FileBrowserContent source={source} />
  </FilePreviewProvider>
}

function FileBrowserContent({ source }: { source: FileSource }) {
  const { openTabs, setOpenTabs, activeTabIndex, setActiveTabIndex, openTab, closeTab, setPdfPage } = useFilePreviewTabs<FileBrowserTab>(getFileBrowserTabKey, [directoryTab])
  const activeTab = openTabs[activeTabIndex]
  const file = source.useFile(activeTab.kind === 'file' ? activeTab.filePath : null, activeTab.kind === 'file' ? activeTab.version : 0)

  return <TabbedFilePreview
    tabs={openTabs} getTabKey={getFileBrowserTabKey} activeTabIndex={activeTabIndex}
    onSelectTab={setActiveTabIndex} onCloseTab={closeTab}
    file={activeTab.kind === 'file' && file ? { path: activeTab.filePath, ...file } : null}
    onPdfPageChange={page => setPdfPage(getFileBrowserTabKey(activeTab), page)}
    folderContent={activeTab.kind === 'folder' && <DirectoryBrowser
      folder={activeTab} useEntries={source.useEntries}
      onToggle={path => setOpenTabs(current => current.map(tab => tab.kind === 'folder'
        ? { ...tab, expandedPaths: tab.expandedPaths.includes(path) ? tab.expandedPaths.filter(value => value !== path) : [...tab.expandedPaths, path] } : tab))}
      onQueryChange={query => setOpenTabs(current => current.map(tab => tab.kind === 'folder' ? { ...tab, query } : tab))}
      onOpenFile={entry => {
        setOpenTabs(current => current.map(tab => tab.kind === 'folder' ? { ...tab, selectedPath: entry.path } : tab))
        const version = nextFileVersion()
        openTab({ kind: 'file', filePath: entry.path, displayName: entry.name, version, pdfPage: 1 }, existing => ({ ...existing, version }))
      }}
    />}
  />
}
