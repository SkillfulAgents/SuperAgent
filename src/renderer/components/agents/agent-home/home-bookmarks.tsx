import { useState } from 'react'
import { ExternalLink, Folder, PanelRightOpen, Pencil, Trash2 } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
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
import { useBookmarks, useUpdateBookmarks, type Bookmark } from '@renderer/hooks/use-bookmarks'
import { useFilePreview } from '@renderer/context/file-preview-context'

interface HomeBookmarksProps {
  agentSlug: string
  isOwner?: boolean
}

function getPathName(filePath: string): string {
  const normalized = filePath.replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized
}

function faviconUrl(link: string): string | null {
  try {
    const { origin } = new URL(link)
    return `${origin}/favicon.ico`
  } catch {
    return null
  }
}

function LinkIcon({ link }: { link: string }) {
  const favicon = faviconUrl(link)
  const [failed, setFailed] = useState(false)

  if (!favicon || failed) {
    return <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
  }

  return (
    <img
      src={favicon}
      alt=""
      className="h-4 w-4 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  )
}

function BookmarkRow({
  bookmark,
  isOwner,
  onRename,
  onDelete,
  onOpenFile,
  onOpenFolder,
}: {
  bookmark: Bookmark
  isOwner: boolean
  onRename: () => void
  onDelete: () => void
  onOpenFile: (filePath: string) => void
  onOpenFolder: (folderPath: string) => void
}) {
  const inner = bookmark.link ? (
    <a
      href={bookmark.link}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 py-2.5 px-1 hover:bg-muted/50 transition-colors"
    >
      <LinkIcon link={bookmark.link} />
      <span className="text-xs font-medium truncate">{bookmark.name}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
    </a>
  ) : bookmark.folder ? (
    <button
      type="button"
      onClick={() => onOpenFolder(bookmark.folder!)}
      className="group flex w-full items-center gap-3 py-2.5 px-1 text-left hover:bg-muted/50 transition-colors"
      title={`Browse ${getPathName(bookmark.folder)}`}
      aria-label={bookmark.name}
    >
      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="text-xs font-medium truncate">{bookmark.name}</span>
      <PanelRightOpen className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
    </button>
  ) : bookmark.file ? (
    <button
      type="button"
      onClick={() => onOpenFile(bookmark.file!)}
      className="group flex w-full items-center gap-3 py-2.5 px-1 text-left hover:bg-muted/50 transition-colors"
      title={`Preview ${getPathName(bookmark.file)}`}
      aria-label={bookmark.name}
    >
      <FileTypeIcon filename={getPathName(bookmark.file)} size={16} />
      <span className="text-xs font-medium truncate">{bookmark.name}</span>
      <PanelRightOpen className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity ml-auto" />
    </button>
  ) : null

  if (!inner) return null

  if (!isOwner) return inner

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {inner}
      </ContextMenuTrigger>
      <ContextMenuContent className="w-44">
        <ContextMenuItem onClick={onRename}>
          <Pencil className="h-3.5 w-3.5 mr-2" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" onClick={onDelete}>
          <Trash2 className="h-3.5 w-3.5 mr-2" />
          Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function HomeBookmarks({ agentSlug, isOwner = false }: HomeBookmarksProps) {
  const { openFile, openFolder } = useFilePreview()
  const { data: bookmarks } = useBookmarks(agentSlug)
  const updateBookmarks = useUpdateBookmarks(agentSlug)
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [newName, setNewName] = useState('')

  if (!bookmarks || bookmarks.length === 0) return null

  const handleRename = async () => {
    if (renameIndex == null || !bookmarks) return
    const trimmed = newName.trim()
    if (!trimmed || trimmed === bookmarks[renameIndex].name) {
      setRenameIndex(null)
      return
    }
    const updated = bookmarks.map((b, i) => i === renameIndex ? { ...b, name: trimmed } : b)
    await updateBookmarks.mutateAsync(updated)
    setRenameIndex(null)
  }

  const handleDelete = async () => {
    if (deleteIndex == null || !bookmarks) return
    const updated = bookmarks.filter((_, i) => i !== deleteIndex)
    await updateBookmarks.mutateAsync(updated)
    setDeleteIndex(null)
  }

  return (
    <div>
      <h2 className="text-sm font-medium text-muted-foreground mb-1">Bookmarks</h2>
      <div className="border-b mb-1" />
      <div className="divide-y divide-border/50">
        {bookmarks.map((bookmark, i) => (
          <BookmarkRow
            key={bookmark.link ?? bookmark.file ?? bookmark.folder ?? i}
            bookmark={bookmark}
            isOwner={isOwner}
            onRename={() => { setNewName(bookmark.name); setRenameIndex(i) }}
            onDelete={() => setDeleteIndex(i)}
            onOpenFile={(filePath) => openFile(filePath, agentSlug)}
            onOpenFolder={(folderPath) => openFolder(folderPath, agentSlug)}
          />
        ))}
      </div>

      <Dialog open={renameIndex != null} onOpenChange={(open) => { if (!open) setRenameIndex(null) }}>
        <DialogContent className="overflow-hidden">
          <DialogHeader>
            <DialogTitle>Rename Bookmark</DialogTitle>
            <DialogDescription>Enter a new name for this bookmark.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); handleRename() }}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Bookmark name"
              autoFocus
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setRenameIndex(null)}>Cancel</Button>
              <Button type="submit" disabled={updateBookmarks.isPending || !newName.trim()}>
                {updateBookmarks.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteIndex != null} onOpenChange={(open) => { if (!open) setDeleteIndex(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Bookmark</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{deleteIndex != null ? bookmarks[deleteIndex]?.name : ''}&quot;?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={updateBookmarks.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {updateBookmarks.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
