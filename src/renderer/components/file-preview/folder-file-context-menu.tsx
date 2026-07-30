import { useState, type ReactNode } from 'react'
import {
  BookmarkMinus,
  BookmarkPlus,
  ClipboardCopy,
  Download,
  FolderSearch,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useFilePreview, type FolderTab } from '@renderer/context/file-preview-context'
import { useUser } from '@renderer/context/user-context'
import { apiFetch } from '@renderer/lib/api'
import { downloadBlob } from '@renderer/lib/download'
import { getAgentFileApiPath } from '@renderer/lib/workspace-file-url'
import type { FolderEntry } from '@renderer/hooks/use-folder-entries'
import type { Bookmark } from '@renderer/hooks/use-bookmarks'
import { isCopyableTextFile } from './file-types'

interface FolderEntryContextMenuProps {
  folder: FolderTab
  entry: FolderEntry
  bookmarks: Bookmark[]
  bookmarksLoading: boolean
  updateBookmarks: {
    mutateAsync: (bookmarks: Bookmark[]) => Promise<Bookmark[]>
    isPending: boolean
  }
  children: ReactNode
}

function isValidFileName(name: string): boolean {
  return name !== ''
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0')
}

async function getResponseError(response: Response, fallback: string): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: string } | null
  return payload?.error ?? fallback
}

function pathAtOrBelow(basePath: string, candidatePath: string): boolean {
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`)
}

function rebasePath(candidatePath: string, oldPath: string, newPath: string): string {
  return pathAtOrBelow(oldPath, candidatePath)
    ? `${newPath}${candidatePath.slice(oldPath.length)}`
    : candidatePath
}

function revealLabel(): string {
  if (window.electronAPI?.platform === 'darwin') return 'Reveal in Finder'
  if (window.electronAPI?.platform === 'win32') return 'Reveal in File Explorer'
  return 'Reveal in Files'
}

export function FolderEntryContextMenu({
  folder,
  entry,
  bookmarks,
  bookmarksLoading,
  updateBookmarks,
  children,
}: FolderEntryContextMenuProps) {
  const {
    renameFilePath,
    removeFilePath,
    renameDirectoryPath,
    removeDirectoryPath,
  } = useFilePreview()
  const { canAdminAgent } = useUser()
  const queryClient = useQueryClient()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [newName, setNewName] = useState(entry.name)
  const [isRenaming, setIsRenaming] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const canManage = canAdminAgent(folder.agentSlug)
  const isDirectory = entry.type === 'directory'
  const entryKind = isDirectory ? 'directory' : 'file'
  const entryLabel = isDirectory ? 'Folder' : 'File'
  const trimmedName = newName.trim()
  const fileApiPath = getAgentFileApiPath(folder.agentSlug, entry.path)
  const bookmarkList = bookmarks
  const isBookmarked = bookmarkList.some(bookmark => (
    isDirectory ? bookmark.folder === entry.path : bookmark.file === entry.path
  ))
  const electronRevealAvailable = !!window.electronAPI?.revealInFolder

  const refreshFolder = () => queryClient.invalidateQueries({
    queryKey: ['folder-entries', folder.agentSlug, folder.rootPath],
  })

  const handleCopy = async () => {
    try {
      const response = await apiFetch(`${fileApiPath}?inline=true`)
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to copy file'))
      await navigator.clipboard.writeText(await response.text())
      toast.success(`Copied contents of “${entry.name}”`)
    } catch (error) {
      toast.error('Could not copy file contents', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleDownload = async () => {
    try {
      const response = await apiFetch(fileApiPath)
      if (!response.ok) throw new Error(await getResponseError(response, 'Failed to download file'))
      await downloadBlob(response, entry.name)
    } catch (error) {
      toast.error('Could not download file', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleBookmark = async () => {
    try {
      const updated = isBookmarked
        ? bookmarkList.filter(bookmark => (
          isDirectory ? bookmark.folder !== entry.path : bookmark.file !== entry.path
        ))
        : [
          ...bookmarkList,
          isDirectory
            ? { name: entry.name, folder: entry.path }
            : { name: entry.name, file: entry.path },
        ]
      await updateBookmarks.mutateAsync(updated)
      toast.success(isBookmarked ? `Removed bookmark for “${entry.name}”` : `Bookmarked “${entry.name}”`)
    } catch (error) {
      toast.error(isBookmarked ? 'Could not remove bookmark' : 'Could not add bookmark', {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleReveal = async () => {
    const electronApi = window.electronAPI
    if (!electronApi?.revealInFolder) return
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(folder.agentSlug)}/folders/reveal-path`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: folder.rootPath, path: entry.path }),
        },
      )
      if (!response.ok) throw new Error(await getResponseError(response, `Failed to reveal ${entryKind}`))
      const { hostPath } = await response.json() as { hostPath: string }
      const revealError = await electronApi.revealInFolder(hostPath)
      if (revealError) throw new Error(revealError)
    } catch (error) {
      toast.error(`Could not reveal ${entryKind}`, {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const handleRename = async () => {
    if (!isValidFileName(trimmedName) || trimmedName === entry.name) return
    setIsRenaming(true)
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(folder.agentSlug)}/folders/${entryKind}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: folder.rootPath, path: entry.path, name: trimmedName }),
        },
      )
      if (!response.ok) throw new Error(await getResponseError(response, `Failed to rename ${entryKind}`))
      const result = await response.json() as { path: string }
      if (isDirectory) renameDirectoryPath(entry.path, result.path)
      else renameFilePath(entry.path, result.path)
      setRenameOpen(false)
      await refreshFolder()
      const updatedBookmarks = bookmarkList.map(bookmark => {
        if (bookmark.file && pathAtOrBelow(entry.path, bookmark.file)) {
          return { ...bookmark, file: rebasePath(bookmark.file, entry.path, result.path) }
        }
        if (bookmark.folder && pathAtOrBelow(entry.path, bookmark.folder)) {
          return { ...bookmark, folder: rebasePath(bookmark.folder, entry.path, result.path) }
        }
        return bookmark
      })
      if (updatedBookmarks.some((bookmark, index) => bookmark !== bookmarkList[index])) {
        try {
          await updateBookmarks.mutateAsync(updatedBookmarks)
        } catch {
          toast.error('Renamed successfully, but related bookmarks could not be updated')
        }
      }
      toast.success(`Renamed to “${trimmedName}”`)
    } catch (error) {
      toast.error(`Could not rename ${entryKind}`, {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setIsRenaming(false)
    }
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const response = await apiFetch(
        `/api/agents/${encodeURIComponent(folder.agentSlug)}/folders/${entryKind}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ root: folder.rootPath, path: entry.path }),
        },
      )
      if (!response.ok) throw new Error(await getResponseError(response, `Failed to delete ${entryKind}`))
      if (isDirectory) removeDirectoryPath(entry.path)
      else removeFilePath(entry.path)
      setDeleteOpen(false)
      await refreshFolder()
      const updatedBookmarks = bookmarkList.filter(bookmark => (
        !(bookmark.file && pathAtOrBelow(entry.path, bookmark.file))
        && !(bookmark.folder && pathAtOrBelow(entry.path, bookmark.folder))
      ))
      if (updatedBookmarks.length !== bookmarkList.length) {
        try {
          await updateBookmarks.mutateAsync(updatedBookmarks)
        } catch {
          toast.error('Deleted successfully, but related bookmarks could not be removed')
        }
      }
      toast.success(`Deleted “${entry.name}”`)
    } catch (error) {
      toast.error(`Could not delete ${entryKind}`, {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setIsDeleting(false)
    }
  }

  // Read-only users still get copy/download for files, but directories have no
  // non-mutating web actions. Avoid opening a blank context menu for them.
  if (isDirectory && !canManage) return <>{children}</>

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent className={electronRevealAvailable ? 'w-52' : 'w-44'}>
          {!isDirectory && isCopyableTextFile(entry.path) && (
            <ContextMenuItem onClick={handleCopy} data-testid="folder-file-copy">
              <ClipboardCopy className="mr-2 h-3.5 w-3.5" />
              Copy contents
            </ContextMenuItem>
          )}
          {!isDirectory && (
            <ContextMenuItem onClick={handleDownload} data-testid="folder-file-download">
              <Download className="mr-2 h-3.5 w-3.5" />
              Download
            </ContextMenuItem>
          )}
          {canManage && (
            <>
              {!isDirectory && <ContextMenuSeparator />}
              <ContextMenuItem
                onClick={handleBookmark}
                disabled={bookmarksLoading || updateBookmarks.isPending}
                data-testid={`folder-${entryKind}-bookmark`}
              >
                {isBookmarked ? (
                  <BookmarkMinus className="mr-2 h-3.5 w-3.5" />
                ) : (
                  <BookmarkPlus className="mr-2 h-3.5 w-3.5" />
                )}
                {isBookmarked ? 'Remove bookmark' : 'Bookmark'}
              </ContextMenuItem>
              {electronRevealAvailable && (
                <ContextMenuItem onClick={handleReveal} data-testid={`folder-${entryKind}-reveal`}>
                  <FolderSearch className="mr-2 h-3.5 w-3.5" />
                  {revealLabel()}
                </ContextMenuItem>
              )}
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => {
                  setNewName(entry.name)
                  setRenameOpen(true)
                }}
                data-testid={`folder-${entryKind}-rename`}
              >
                <Pencil className="mr-2 h-3.5 w-3.5" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setDeleteOpen(true)}
                data-testid={`folder-${entryKind}-delete`}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {renameOpen && (
        <Dialog open onOpenChange={(open) => { if (!isRenaming) setRenameOpen(open) }}>
          <DialogContent className="overflow-hidden">
            <DialogHeader>
              <DialogTitle>Rename {entryLabel}</DialogTitle>
              <DialogDescription>Enter a new name for “{entry.name}”.</DialogDescription>
            </DialogHeader>
            <form onSubmit={(event) => { event.preventDefault(); void handleRename() }}>
              <Input
                value={newName}
                onChange={event => setNewName(event.target.value)}
                aria-label={`${entryLabel} name`}
                autoFocus
              />
              <DialogFooter className="mt-4">
                <Button type="button" variant="outline" onClick={() => setRenameOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isRenaming || !isValidFileName(trimmedName) || trimmedName === entry.name}
                >
                  {isRenaming ? 'Renaming...' : 'Rename'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}

      {deleteOpen && (
        <AlertDialog open onOpenChange={(open) => { if (!isDeleting) setDeleteOpen(open) }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {entryLabel}</AlertDialogTitle>
              <AlertDialogDescription>
                Are you sure you want to permanently delete “{entry.name}”?
                {isDirectory ? ' Everything inside it will also be deleted.' : ''} This action cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleDelete}
                disabled={isDeleting}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  )
}
