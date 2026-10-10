import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@renderer/components/ui/dropdown-menu'
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
  ChevronDown,
} from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useVolumesManager } from '@renderer/hooks/use-mounts'
import { openableProps } from '@renderer/lib/openable'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { VolumeSettingsDialog } from '@renderer/components/volumes/volume-settings-dialog'
import { VolumeStatusBadge } from '../volume-status-badge'
import type { VolumeSummaryWithHealth } from '@shared/lib/types/mount'

interface HomeVolumesProps {
  agentSlug: string
  className?: string
}

export function HomeVolumes({ agentSlug, className }: HomeVolumesProps) {
  const volumes = useVolumesManager(agentSlug)
  const [showNewVolume, setShowNewVolume] = useState(false)

  // Saved sources can be attached from a browser or cloud workspace, too.
  if (!volumes.canAddMount && volumes.mounts.length === 0 && !volumes.operationError) return null

  return (
    <HomeCollapsible title="Volumes" className={className}>
      {volumes.mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {volumes.mounts.map((mount) => (
            <VolumeRow
              key={mount.id}
              mount={mount}
              onRemove={() => volumes.handleRemove(mount.id)}
              isRemovingMount={volumes.isRemovingMount}
              canRemove={volumes.canModifyMounts}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No volumes yet</p>
          <p className="text-xs mt-1">Attach a saved volume{volumes.canCreateMount ? ' or create a new one' : ''} to give this agent read/write access.</p>
        </div>
      )}

      <div className="mt-3 px-4">
        {volumes.operationError && <p role="alert" className="mb-2 text-xs text-destructive">{volumes.operationError}</p>}
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
        ) : null}
        {volumes.canAddMount && (
          <div className="flex justify-end">
            {volumes.definitions.length > 0 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" disabled={volumes.isAddingMount || volumes.isLoading} data-testid="add-mount-menu">
                    {volumes.isAddingMount ? <Loader2 className="animate-spin" /> : <Plus />}
                    Add Mount <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-72">
                  <DropdownMenuLabel>Saved volumes</DropdownMenuLabel>
                  {volumes.definitions.map(volume => {
                    const attached = volumes.mounts.some(m => m.volumeId === volume.id)
                    return (
                      <DropdownMenuItem key={volume.id} disabled={attached} onSelect={() => { void volumes.handleAttach(volume.id) }}>
                        <Folder className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{volume.name}</span>
                          {(volume.sourceLabel ?? volume.hostPath) && <span className="block truncate text-xs text-muted-foreground">{volume.sourceLabel ?? volume.hostPath}</span>}
                        </span>
                        {attached && <span className="text-xs text-muted-foreground">Mounted</span>}
                      </DropdownMenuItem>
                    )
                  })}
                  {volumes.canCreateMount && <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => setShowNewVolume(true)}><Plus className="h-4 w-4" />New Volume</DropdownMenuItem>
                  </>}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setShowNewVolume(true)} disabled={volumes.isAddingMount || volumes.isLoading}>
                {volumes.isAddingMount ? <Loader2 className="animate-spin" /> : <Plus />} Add Mount
              </Button>
            )}
          </div>
        )}
      </div>
      {showNewVolume && <VolumeSettingsDialog
        attachToAgent
        onSave={volumes.handleCreateMount}
        onClose={() => setShowNewVolume(false)}
      />}
    </HomeCollapsible>
  )
}

function getFileManagerLabel(): string {
  const platform = window.electronAPI?.platform
  if (platform === 'win32') return 'Explorer'
  if (platform === 'darwin') return 'Finder'
  return 'Files'
}

interface VolumeRowProps {
  mount: VolumeSummaryWithHealth
  onRemove: () => void
  isRemovingMount: boolean
  canRemove: boolean
}

function VolumeRow({ mount, onRemove, isRemovingMount, canRemove }: VolumeRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const fileManagerLabel = getFileManagerLabel()
  // `hostPath` is a path on whichever machine runs the agent. Opening it in the
  // file manager only works when that machine is this one; against a cloud
  // workspace it either fails or, worse, opens a same-named folder of yours.
  const { hostPath } = mount
  const sourceLabel = mount.sourceLabel ?? hostPath
  const canOpenInFileManager = canUseHostFeatures() && hostPath !== null

  const handleOpenInFinder = () => {
    if (!canOpenInFileManager) return
    void window.electronAPI?.showInFolder(hostPath)
  }

  const handleCopyPath = () => {
    if (hostPath) void navigator.clipboard.writeText(hostPath)
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
        {...(canOpenInFileManager ? openableProps(handleOpenInFinder) : {})}
        className={`group relative py-3 px-4 transition-colors ${canOpenInFileManager ? 'hover:bg-muted/50 cursor-pointer' : ''}`}
      >
        <div className="flex items-center gap-2">
          <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate">{mount.name}</span>
          <VolumeStatusBadge health={mount.health} />
        </div>
        {sourceLabel && (
          <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={sourceLabel}>
            {sourceLabel}
          </div>
        )}
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
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
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
              {hostPath && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleCopyPath()
                    setMenuOpen(false)
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy path
                </button>
              )}
              {canRemove && <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  setShowDeleteDialog(true)
                  setMenuOpen(false)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Remove Mount
              </button>}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Mount</AlertDialogTitle>
            <AlertDialogDescription>
              Detach &quot;{mount.name}&quot; from this agent? The saved volume and its files will remain available. Restart the agent to remove the mount from its filesystem.
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
