import { useRef, useState, useEffect, useCallback } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Plus, FileIcon, FolderOpen, Loader2 } from 'lucide-react'
import { FileTypeIcon } from '@renderer/components/ui/file-type-icon'

interface RecentFile {
  name: string
  path: string
  thumbnail?: string
}

interface AttachmentPickerProps {
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onFolderSelect: (e: React.ChangeEvent<HTMLInputElement>) => void
  onRecentFileAttach?: (file: File) => void
  disabled?: boolean
  buttonClassName?: string
  popoverAlign?: 'start' | 'center' | 'end'
}

// Cache recent files for 30s to avoid re-fetching on rapid open/close (#7)
let recentFilesCache: { files: RecentFile[]; fetchedAt: number } | null = null
const CACHE_TTL = 30_000

export function AttachmentPicker({
  onFileSelect,
  onFolderSelect,
  onRecentFileAttach,
  disabled,
  buttonClassName = 'h-[34px] px-3',
  popoverAlign = 'start',
}: AttachmentPickerProps) {
  const [open, setOpen] = useState(false)
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>(recentFilesCache?.files ?? [])
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)
  const isElectron = !!window.electronAPI?.getRecentFiles

  // Fetch recent files when the popover opens, with short cache (#7)
  useEffect(() => {
    if (!open || !isElectron) return
    if (recentFilesCache && Date.now() - recentFilesCache.fetchedAt < CACHE_TTL) {
      setRecentFiles(recentFilesCache.files)
      return
    }
    let cancelled = false
    window.electronAPI!.getRecentFiles(5).then((files) => {
      if (cancelled) return
      recentFilesCache = { files, fetchedAt: Date.now() }
      setRecentFiles(files)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [open, isElectron])

  const handleRecentClick = useCallback(async (filePath: string) => {
    if (!onRecentFileAttach) return
    const api = window.electronAPI
    if (!api?.readLocalFile) return

    // Show loading state instead of closing immediately (#8)
    setLoadingPath(filePath)
    try {
      const result = await api.readLocalFile(filePath)
      if (!result) {
        // File may have been deleted since the list was fetched
        console.warn('Failed to read recent file:', filePath)
        return
      }
      const file = new File([result.buffer], result.name, { type: result.type })
      onRecentFileAttach(file)
    } catch (err) {
      console.error('Failed to attach recent file:', err)
    } finally {
      setLoadingPath(null)
      setOpen(false)
    }
  }, [onRecentFileAttach])

  const showRecent = isElectron && recentFiles.length > 0 && onRecentFileAttach

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onFileSelect}
      />
      <input
        ref={folderInputRef}
        type="file"
        className="hidden"
        onChange={onFolderSelect}
        {...{ webkitdirectory: '', directory: '' } as React.InputHTMLAttributes<HTMLInputElement>}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={buttonClassName}
            disabled={disabled}
            title="Add files"
          >
            <Plus className="mr-1 h-4 w-4" />
            Add files
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align={popoverAlign} className={`${showRecent ? 'w-64' : 'w-40'} p-1`}>
          {showRecent && (
            <>
              <div className="px-2 py-1 text-xs text-muted-foreground">Recent</div>
              {recentFiles.map((file) => (
                <button
                  key={file.path}
                  type="button"
                  className="flex items-center gap-2 w-full rounded-sm px-2 py-1.5 hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  disabled={loadingPath !== null}
                  onClick={() => handleRecentClick(file.path)}
                >
                  {loadingPath === file.path ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : file.thumbnail ? (
                    <img src={file.thumbnail} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" />
                  ) : (
                    <FileTypeIcon filename={file.name} size={14} />
                  )}
                  <span className="truncate text-xs">{file.name}</span>
                </button>
              ))}
              <div className="-mx-1 my-1 h-px bg-border" />
            </>
          )}
          <button
            type="button"
            className="flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => { setOpen(false); fileInputRef.current?.click() }}
          >
            <FileIcon className="h-4 w-4" />
            Files
          </button>
          <button
            type="button"
            className="flex items-center gap-2 w-full rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => { setOpen(false); folderInputRef.current?.click() }}
          >
            <FolderOpen className="h-4 w-4" />
            Folder
          </button>
        </PopoverContent>
      </Popover>
    </>
  )
}
