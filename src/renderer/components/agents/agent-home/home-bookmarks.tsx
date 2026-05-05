import { useState } from 'react'
import { ArrowDownToLine, ArrowUpRight, File, Globe, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
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
import { getApiBaseUrl } from '@renderer/lib/env'
import { HomeCollapsible } from './home-collapsible'
import { useBookmarks, useUpdateBookmarks, type Bookmark } from '@renderer/hooks/use-bookmarks'

interface HomeBookmarksProps {
  agentSlug: string
  isOwner?: boolean
}

function getRelativePath(filePath: string): string {
  return filePath.replace(/^\/workspace\//, '')
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
    return <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  }

  return (
    <img
      src={favicon}
      alt=""
      className="h-3.5 w-3.5 shrink-0 rounded-sm"
      onError={() => setFailed(true)}
    />
  )
}

function BookmarkRow({
  bookmark,
  agentSlug,
  isOwner,
  onRename,
  onDelete,
}: {
  bookmark: Bookmark
  agentSlug: string
  isOwner: boolean
  onRename: () => void
  onDelete: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)

  const href = bookmark.link
    ? bookmark.link
    : bookmark.file
      ? `${getApiBaseUrl()}/api/agents/${agentSlug}/files/${getRelativePath(bookmark.file)}`
      : null

  if (!href) return null

  const icon = bookmark.link ? (
    <LinkIcon link={bookmark.link} />
  ) : (
    <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
  )

  return (
    <div className="group relative">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 py-3 px-4 hover:bg-muted/50 transition-colors min-w-0"
      >
        {icon}
        <span className="text-xs font-medium truncate shrink-0">{bookmark.name}</span>
        <span className="text-[11px] text-muted-foreground truncate min-w-0">
          {bookmark.link ?? (bookmark.file ? getRelativePath(bookmark.file) : '')}
        </span>
        {bookmark.link ? (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        ) : (
          <ArrowDownToLine className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
        )}
      </a>
      {isOwner && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label="Bookmark actions"
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-36 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={() => {
                  setMenuOpen(false)
                  onRename()
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Rename
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={() => {
                  setMenuOpen(false)
                  onDelete()
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete
              </button>
            </PopoverContent>
          </Popover>
        </div>
      )}
    </div>
  )
}

export function HomeBookmarks({ agentSlug, isOwner = false }: HomeBookmarksProps) {
  const { data: bookmarks } = useBookmarks(agentSlug)
  const updateBookmarks = useUpdateBookmarks(agentSlug)
  const [renameIndex, setRenameIndex] = useState<number | null>(null)
  const [deleteIndex, setDeleteIndex] = useState<number | null>(null)
  const [newName, setNewName] = useState('')

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
    <HomeCollapsible title="Bookmarks">
      {bookmarks && bookmarks.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {bookmarks.map((bookmark, i) => (
            <BookmarkRow
              key={bookmark.link ?? bookmark.file ?? i}
              bookmark={bookmark}
              agentSlug={agentSlug}
              isOwner={isOwner}
              onRename={() => { setNewName(bookmark.name); setRenameIndex(i) }}
              onDelete={() => setDeleteIndex(i)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No bookmarks yet</p>
          <p className="text-xs mt-1">Your agent automatically saves links and files here for quick access. You can also ask it to bookmark something for you.</p>
        </div>
      )}

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
              Are you sure you want to delete &quot;{deleteIndex != null && bookmarks ? bookmarks[deleteIndex]?.name : ''}&quot;?
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
    </HomeCollapsible>
  )
}
