import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { MoreVertical, Folder, FolderOpen, Copy, Trash2, RefreshCw, Unlink } from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useVolumesManager, type SharedVolumeListItem } from '@renderer/hooks/use-mounts'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { VolumeStatusBadge } from '../volume-status-badge'
import type { MountRecord } from '@shared/lib/types/mount'
import { AddVolumeMenu } from './add-volume-menu'

interface HomeVolumesProps {
  agentSlug: string
  className?: string
}

export function HomeVolumes({ agentSlug, className }: HomeVolumesProps) {
  const volumes = useVolumesManager(agentSlug)
  const canAddAnything = volumes.canAddFolder || volumes.sharedVolumes

  // Nothing mounted and no way to mount anything: the section would be an
  // empty box inviting you to do something this window or server cannot do.
  if (!canAddAnything && volumes.mounts.length === 0) return null

  return (
    <HomeCollapsible title="Volumes" className={className}>
      {volumes.mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {volumes.mounts.map((mount) => (
            <MountRow
              key={mount.id}
              mount={mount}
              registryEntry={volumes.registry.find((v) => v.id === mount.id)}
              registryReady={volumes.registryReady}
              agentSlug={agentSlug}
              isRemoving={volumes.isRemovingMount}
              onRemove={() => volumes.handleRemove(mount.id)}
              onDetach={() => { void volumes.detachShared(mount.id) }}
              onDelete={() => { void volumes.deleteShared(mount.id) }}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No volumes yet</p>
          <p className="text-xs mt-1">
            {volumes.sharedVolumes
              ? 'Create a shared folder in your workspace. Every agent you attach it to can read and write its files.'
              : 'Mount a folder from your computer to give your agents direct read/write access to the files in it.'}
          </p>
        </div>
      )}

      {volumes.actionError && (
        <p className="mt-2 px-4 text-xs text-destructive" role="alert">{volumes.actionError}</p>
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
              <span className="text-xs text-destructive" role="alert">{volumes.restartError}</span>
            )}
          </div>
        ) : canAddAnything ? (
          <div className="flex justify-end">
            <AddVolumeMenu
              agentSlug={agentSlug}
              canAddFolder={volumes.canAddFolder}
              isAddingFolder={volumes.isAddingMount}
              onAddFolder={volumes.handleAddFolder}
              sharedVolumes={volumes.sharedVolumes}
              registry={volumes.registry}
              onCreate={volumes.createShared}
              onAttach={volumes.attachShared}
              onDelete={volumes.deleteShared}
            />
          </div>
        ) : null}
      </div>
    </HomeCollapsible>
  )
}

function getFileManagerLabel(): string {
  const platform = window.electronAPI?.platform
  if (platform === 'win32') return 'Explorer'
  if (platform === 'darwin') return 'Finder'
  return 'Files'
}

interface MountRowProps {
  mount: MountRecord
  registryEntry?: SharedVolumeListItem
  registryReady: boolean
  agentSlug: string
  isRemoving: boolean
  onRemove: () => void
  onDetach: () => void
  onDelete: () => void
}

type RowConfirm = 'remove' | 'detach' | 'delete' | null

function MountRow({ mount, registryEntry, registryReady, agentSlug, isRemoving, onRemove, onDetach, onDelete }: MountRowProps) {
  const [confirm, setConfirm] = useState<RowConfirm>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const fileManagerLabel = getFileManagerLabel()
  const isShared = mount.source === 'shared'
  // `hostPath` is a path on whichever machine runs the agent. Opening it in the
  // file manager only works when that machine is this one; against a cloud
  // workspace it either fails or, worse, opens a same-named folder of yours.
  // A shared volume lives in the app's data dir and is never opened from here.
  const canOpenInFileManager = !isShared && canUseHostFeatures()
  const subtitle = isShared ? mount.containerPath : mount.hostPath
  const attachedAgents = registryEntry?.attachedAgents ?? []
  const attachedNames = attachedAgents.map((agent) => agent.name).join(', ')
  const canDelete = isShared && registryReady && registryEntry !== undefined && attachedAgents.every((agent) => agent.slug === agentSlug)

  const handleOpenInFinder = () => {
    if (!canOpenInFileManager) return
    void window.electronAPI?.showInFolder(mount.hostPath)
  }

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(subtitle)
  }

  const runConfirmed = () => {
    if (confirm === 'remove') onRemove()
    else if (confirm === 'detach') onDetach()
    else if (confirm === 'delete') onDelete()
    setConfirm(null)
  }

  const dialogCopy: Record<Exclude<RowConfirm, null>, { title: string; body: string; action: string; destructive: boolean }> = {
    remove: { title: 'Remove Mount', body: `Are you sure you want to unmount "${mount.folderName}"? The agent will lose access to this folder after restarting.`, action: isRemoving ? 'Removing...' : 'Remove Mount', destructive: true },
    detach: { title: 'Detach shared volume', body: `Detach "${mount.folderName}"? This agent will lose access after restart. Files stay on the shared volume.`, action: 'Detach', destructive: false },
    delete: { title: 'Delete shared volume', body: `Delete "${mount.folderName}"? This permanently deletes the folder and its files.`, action: 'Delete', destructive: true },
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
        <div className="text-xs text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={subtitle}>
          {subtitle}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                aria-label={isShared ? 'Shared volume actions' : 'Mount actions'}
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              {isShared && attachedNames && (
                <div className="px-2 py-1.5 text-xs text-muted-foreground">Attached agents: {attachedNames}</div>
              )}
              {canOpenInFileManager && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); handleOpenInFinder(); setMenuOpen(false) }}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  Open in {fileManagerLabel}
                </button>
              )}
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => { e.stopPropagation(); handleCopyPath(); setMenuOpen(false) }}
              >
                <Copy className="h-3.5 w-3.5" />
                Copy path
              </button>
              {isShared ? (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                  onClick={(e) => { e.stopPropagation(); setConfirm('detach'); setMenuOpen(false) }}
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Detach shared volume
                </button>
              ) : (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setConfirm('remove'); setMenuOpen(false) }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Remove Mount
                </button>
              )}
              {canDelete && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
                  onClick={(e) => { e.stopPropagation(); setConfirm('delete'); setMenuOpen(false) }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete shared volume
                </button>
              )}
            </PopoverContent>
          </Popover>
        </div>
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }}>
        <AlertDialogContent>
          {confirm && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>{dialogCopy[confirm].title}</AlertDialogTitle>
                <AlertDialogDescription>{dialogCopy[confirm].body}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{confirm === 'remove' ? 'Keep Mount' : 'Cancel'}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={runConfirmed}
                  disabled={confirm === 'remove' && isRemoving}
                  className={dialogCopy[confirm].destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
                >
                  {dialogCopy[confirm].action}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
