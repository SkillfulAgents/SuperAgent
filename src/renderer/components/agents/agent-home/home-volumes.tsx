import { forwardRef, useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
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
import {
  MoreVertical,
  Folder,
  FolderOpen,
  Copy,
  Trash2,
  Plus,
  Loader2,
  RefreshCw,
  ChevronLeft,
} from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useVolumesManager } from '@renderer/hooks/use-mounts'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { VolumeStatusBadge } from '../volume-status-badge'
import { toSharedVolumeName } from '@shared/lib/utils/shared-volume-name'
import type { AgentMountWithHealth } from '@shared/lib/types/mount'

interface HomeVolumesProps {
  agentSlug: string
  className?: string
}

export function HomeVolumes({ agentSlug, className }: HomeVolumesProps) {
  const volumes = useVolumesManager(agentSlug)

  // Nothing mounted and no way to mount anything (a window on another machine,
  // where the folder picker would browse the wrong computer): the section would
  // be an empty box inviting you to do something this window cannot do.
  if (!volumes.canAddMount && volumes.mounts.length === 0) return null

  return (
    <HomeCollapsible title="Volumes" className={className}>
      {volumes.mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {volumes.mounts.map((mount) => (
            <VolumeRow
              key={mount.id}
              mount={mount}
              // A shared volume's host path is on the workspace disk; the agent's
              // path is the one worth showing and copying.
              path={volumes.sharedVolumes ? mount.containerPath : mount.hostPath}
              onRemove={() => volumes.handleRemove(mount.id)}
              isRemovingMount={volumes.isRemovingMount}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No volumes yet</p>
          <p className="text-xs mt-1">
            {volumes.sharedVolumes
              ? 'Add a shared volume to give this agent read/write access to a folder other agents can use too.'
              : 'Mount a folder from your computer to give your agents direct read/write access to the files in it.'}
          </p>
        </div>
      )}

      <div className="mt-3 px-4">
        {volumes.pendingRestart ? (
          <div className="flex flex-col gap-1 rounded-lg bg-orange-50 dark:bg-orange-950/30 p-2.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-orange-600 dark:text-orange-400 flex-1">
                Restart your agent for mount changes to take effect.
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40 hover:text-orange-700 dark:hover:text-orange-300"
                onClick={volumes.handleRestart}
                disabled={volumes.isRestarting}
              >
                <RefreshCw className={`${volumes.isRestarting ? 'animate-spin' : ''}`} />
                {volumes.isRestarting ? 'Restarting...' : 'Restart'}
              </Button>
            </div>
            {volumes.restartError && (
              <span className="text-xs text-destructive" role="alert">
                {volumes.restartError}
              </span>
            )}
          </div>
        ) : volumes.sharedVolumes ? (
          <div className="flex justify-end">
            <AddSharedVolume
              sharedVolumes={volumes.sharedVolumes}
              mountedPaths={volumes.mounts.map((m) => m.containerPath)}
              isAdding={volumes.isAddingMount}
              onAdd={volumes.handleAddSharedVolume}
            />
          </div>
        ) : volumes.canAddMount ? (
          <div className="flex justify-end">
            <AddMountButton isAdding={volumes.isAddingMount} onClick={volumes.handleAddMount} />
          </div>
        ) : null}
      </div>
    </HomeCollapsible>
  )
}

/** The card's one add action: opens the folder picker locally, the volume menu on cloud. */
const AddMountButton = forwardRef<
  HTMLButtonElement,
  React.ComponentProps<typeof Button> & { isAdding: boolean }
>(({ isAdding, ...props }, ref) => (
  <Button ref={ref} variant="ghost" size="sm" disabled={isAdding} {...props}>
    {isAdding ? <Loader2 className="animate-spin" /> : <Plus />}
    Add Mount
  </Button>
))
AddMountButton.displayName = 'AddMountButton'

const MENU_ITEM = 'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors'

interface AddSharedVolumeProps {
  sharedVolumes: string[]
  mountedPaths: string[]
  isAdding: boolean
  onAdd: (name: string) => Promise<void>
}

/**
 * The cloud stand-in for the folder picker: the workspace's shared volumes this
 * agent does not have yet, and a way to name a new one.
 */
function AddSharedVolume({ sharedVolumes, mountedPaths, isAdding, onAdd }: AddSharedVolumeProps) {
  const [open, setOpen] = useState(false)
  const [naming, setNaming] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const isMounted = (name: string) => mountedPaths.includes(`/mounts/${name}`)
  const available = sharedVolumes.filter((name) => !isMounted(name))
  const name = toSharedVolumeName(input)
  const exists = sharedVolumes.includes(name)
  const canSubmit = name !== '' && !isMounted(name) && !isAdding
  const hint = !name
    ? 'Lowercase letters, numbers, and dashes'
    : isMounted(name) ? `Already mounted at /mounts/${name}` : `/mounts/${name}`

  const reset = () => {
    setNaming(false)
    setInput('')
    setError(null)
  }

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) reset()
  }

  const add = async (volume: string) => {
    setError(null)
    try {
      await onAdd(volume)
      handleOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add volume')
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <AddMountButton isAdding={isAdding} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-1">
        {naming ? (
          <form
            className="flex flex-col gap-2 p-1.5"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) void add(name)
            }}
          >
            <Input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Team brain"
              aria-label="Volume name"
              className="h-8 text-xs md:text-xs"
            />
            <p className="text-2xs font-mono text-muted-foreground break-words">{hint}</p>
            <div className="flex justify-between">
              <Button type="button" variant="ghost" size="sm" onClick={reset}>
                <ChevronLeft />
                Back
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {exists ? 'Mount' : 'Create'}
              </Button>
            </div>
          </form>
        ) : (
          <>
            {/* Scrolls on its own so "New shared volume" stays in reach. */}
            <div className="max-h-60 overflow-y-auto overscroll-contain">
              {available.map((volume) => (
                <button key={volume} className={MENU_ITEM} disabled={isAdding} onClick={() => void add(volume)}>
                  <Folder className="h-3.5 w-3.5" />
                  <span className="truncate">{volume}</span>
                </button>
              ))}
            </div>
            {available.length > 0 && <Separator className="-mx-1 my-1 w-auto" />}
            <button className={MENU_ITEM} onClick={() => setNaming(true)}>
              <Plus className="h-3.5 w-3.5" />
              New shared volume
            </button>
          </>
        )}
        {error && <p role="alert" className="px-2 py-1.5 text-xs text-destructive">{error}</p>}
      </PopoverContent>
    </Popover>
  )
}

function getFileManagerLabel(): string {
  const platform = window.electronAPI?.platform
  if (platform === 'win32') return 'Explorer'
  if (platform === 'darwin') return 'Finder'
  return 'Files'
}

interface VolumeRowProps {
  mount: AgentMountWithHealth
  /** The path the row shows and copies. */
  path: string
  onRemove: () => void
  isRemovingMount: boolean
}

function VolumeRow({ mount, path, onRemove, isRemovingMount }: VolumeRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const fileManagerLabel = getFileManagerLabel()
  // `hostPath` is a path on whichever machine runs the agent. Opening it in the
  // file manager only works when that machine is this one; against a cloud
  // workspace it either fails or, worse, opens a same-named folder of yours.
  const canOpenInFileManager = canUseHostFeatures()

  const handleOpenInFinder = () => {
    if (!canOpenInFileManager) return
    void window.electronAPI?.showInFolder(mount.hostPath)
  }

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(path)
  }

  const handleDelete = () => {
    onRemove()
    setShowDeleteDialog(false)
  }

  return (
    <>
      <div
        // Not a button when there is nothing to open: an inert control that
        // still takes focus and highlights on hover promises an action the
        // window cannot perform.
        {...(canOpenInFileManager
          ? {
            role: 'button',
            tabIndex: 0,
            onClick: handleOpenInFinder,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleOpenInFinder()
              }
            },
          }
          : {})}
        className={`group relative py-3 px-4 transition-colors ${canOpenInFileManager ? 'hover:bg-muted/50 cursor-pointer' : ''}`}
      >
        <div className="flex items-center gap-2">
          <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate">{mount.folderName}</span>
          <VolumeStatusBadge health={mount.health} />
        </div>
        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={path}>
          {path}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label="Mount actions"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-1">
              {canOpenInFileManager && (
                <button
                  className={MENU_ITEM}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleOpenInFinder()
                    setMenuOpen(false)
                  }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Open in {fileManagerLabel}
                </button>
              )}
              <button
                className={MENU_ITEM}
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopyPath()
                  setMenuOpen(false)
                }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy path
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                  setMenuOpen(false)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove Mount
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Mount</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to unmount &quot;{mount.folderName}&quot;? The agent will lose access to this folder after restarting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Mount</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isRemovingMount}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRemovingMount ? 'Removing...' : 'Remove Mount'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
