import { useState } from 'react'
import { Button } from '@renderer/components/ui/button'
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
} from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useVolumesManager } from '@renderer/hooks/use-mounts'
import { VolumeStatusBadge } from '../volume-status-badge'
import type { AgentMountWithHealth } from '@shared/lib/types/mount'

interface HomeVolumesProps {
  agentSlug: string
}

export function HomeVolumes({ agentSlug }: HomeVolumesProps) {
  const vm = useVolumesManager(agentSlug)

  return (
    <HomeCollapsible title="Volumes">
      {vm.mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {vm.mounts.map((mount) => (
            <VolumeRow
              key={mount.id}
              mount={mount}
              onRemove={() => vm.handleRemove(mount.id)}
              isRemovingMount={vm.isRemovingMount}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No volumes yet</p>
          <p className="text-xs mt-1">Mount a folder from your computer to give your agents direct read/write access to the files in it.</p>
        </div>
      )}

      <div className="mt-3 px-4">
        {vm.pendingRestart ? (
          <div className="flex items-center gap-2 rounded-lg bg-orange-50 dark:bg-orange-950/30 p-2.5">
            <span className="text-[11px] text-orange-600 dark:text-orange-400 flex-1">
              Restart your agent for mount changes to take effect.
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="text-orange-600 dark:text-orange-400 hover:bg-orange-100 dark:hover:bg-orange-900/40 hover:text-orange-700 dark:hover:text-orange-300"
              onClick={vm.handleRestart}
              disabled={vm.isRestarting}
            >
              <RefreshCw className={`${vm.isRestarting ? 'animate-spin' : ''}`} />
              {vm.isRestarting ? 'Restarting...' : 'Restart'}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={vm.handleAddMount}
              disabled={vm.isAddingMount}
            >
              {vm.isAddingMount ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Plus />
              )}
              Add Mount
            </Button>
          </div>
        )}
      </div>
    </HomeCollapsible>
  )
}

interface VolumeRowProps {
  mount: AgentMountWithHealth
  onRemove: () => void
  isRemovingMount: boolean
}

const FILE_MANAGER_LABEL =
  window.electronAPI?.platform === 'win32' ? 'Explorer' :
  window.electronAPI?.platform === 'darwin' ? 'Finder' : 'Files'

function VolumeRow({ mount, onRemove, isRemovingMount }: VolumeRowProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const handleOpenInFinder = () => {
    void window.electronAPI?.showInFolder(mount.hostPath)
  }

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(mount.hostPath)
  }

  const handleDelete = () => {
    onRemove()
    setShowDeleteDialog(false)
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="group relative py-3 px-4 hover:bg-muted/50 transition-colors cursor-pointer"
        onClick={handleOpenInFinder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleOpenInFinder()
          }
        }}
      >
        <div className="flex items-center gap-2">
          <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate">{mount.folderName}</span>
          <VolumeStatusBadge health={mount.health} />
        </div>
        <div className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1 font-mono" title={mount.hostPath}>
          {mount.hostPath}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-6 w-6"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-40 p-1">
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  handleOpenInFinder()
                  setMenuOpen(false)
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Open in {FILE_MANAGER_LABEL}
              </button>
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
