import { useFilePreview, type FolderTab } from '@renderer/context/file-preview-context'
import { useFolderEntries } from '@renderer/hooks/use-folder-entries'
import { useBookmarks, useUpdateBookmarks } from '@renderer/hooks/use-bookmarks'
import { FolderEntryContextMenu } from './folder-file-context-menu'
import { DirectoryBrowser } from './directory-browser'

export function FolderBrowser({ folder }: { folder: FolderTab }) {
  const { openFile, toggleFolder, selectFolderEntry, setFolderQuery } = useFilePreview()
  const { data: bookmarks = [], isLoading: bookmarksLoading } = useBookmarks(folder.agentSlug)
  const updateBookmarks = useUpdateBookmarks(folder.agentSlug)
  function useEntries(path: string, enabled: boolean) {
    return useFolderEntries(folder.agentSlug, folder.rootPath, path, enabled)
  }
  return <DirectoryBrowser folder={folder} useEntries={useEntries}
    onToggle={path => toggleFolder(folder.rootPath, folder.agentSlug, path)}
    onQueryChange={query => setFolderQuery(folder.rootPath, folder.agentSlug, query)}
    onOpenFile={entry => {
      selectFolderEntry(folder.rootPath, folder.agentSlug, entry.path)
      openFile(entry.path, folder.agentSlug)
    }}
    wrapEntry={(entry, children) => <FolderEntryContextMenu folder={folder} entry={entry}
      bookmarks={bookmarks} bookmarksLoading={bookmarksLoading} updateBookmarks={updateBookmarks}>{children}</FolderEntryContextMenu>}
  />
}
