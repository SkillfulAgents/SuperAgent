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
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { HomeCollapsible } from './home-collapsible'
import { useAgentMounts, useAddMount, useRemoveMount } from '@renderer/hooks/use-mounts'
import { apiFetch } from '@renderer/lib/api'
import type { AgentMountWithHealth } from '@shared/lib/types/mount'

interface HomeVolumesProps {
  agentSlug: string
}

export function HomeVolumes({ agentSlug }: HomeVolumesProps) {
  const { data: mountsData, refetch } = useAgentMounts(agentSlug)
  const mounts = Array.isArray(mountsData) ? mountsData : []
  const addMount = useAddMount()
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  const handleAddMount = async () => {
    const dirPath = await window.electronAPI?.openDirectory()
    if (!dirPath) return
    await addMount.mutateAsync({ agentSlug, hostPath: dirPath })
    setPendingRestart(true)
  }

  const handleRestart = async () => {
    setIsRestarting(true)
    try {
      await apiFetch(`/api/agents/${agentSlug}/stop`, { method: 'POST' })
      await apiFetch(`/api/agents/${agentSlug}/start`, { method: 'POST' })
      setPendingRestart(false)
      refetch()
    } catch (error) {
      console.error('Failed to restart agent:', error)
    } finally {
      setIsRestarting(false)
    }
  }

  return (
    <HomeCollapsible title="Volumes">
      {mounts.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {mounts.map((mount) => (
            <VolumeRow
              key={mount.id}
              mount={mount}
              agentSlug={agentSlug}
              onPendingRestart={() => setPendingRestart(true)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">No volumes yet</p>
          <p className="text-xs mt-1">Mount a folder to give your agent direct access to files on your machine.</p>
        </div>
      )}

      <div className="mt-3 px-4">
        {pendingRestart ? (
          <div className="flex items-center gap-2 rounded-lg bg-orange-50 dark:bg-orange-950/30 p-2.5">
            <span className="text-[11px] text-orange-600 dark:text-orange-400 flex-1">
              Restart your agent for the mount<br />changes to take effect.
            </span>
            <Button
              size="sm"
              className="bg-orange-600 text-white hover:bg-orange-700"
              onClick={handleRestart}
              disabled={isRestarting}
            >
              <RefreshCw className={`${isRestarting ? 'animate-spin' : ''}`} />
              {isRestarting ? 'Restarting...' : 'Restart'}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={handleAddMount}
              disabled={addMount.isPending}
            >
              {addMount.isPending ? (
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
  agentSlug: string
  onPendingRestart: () => void
}

function VolumeRow({ mount, agentSlug, onPendingRestart }: VolumeRowProps) {
  const removeMount = useRemoveMount()
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)

  const handleOpenInFinder = () => {
    void window.electronAPI?.showInFolder(mount.hostPath)
  }

  const handleCopyPath = () => {
    void navigator.clipboard.writeText(mount.hostPath)
  }

  const handleDelete = async () => {
    await removeMount.mutateAsync({ agentSlug, mountId: mount.id })
    setShowDeleteDialog(false)
    onPendingRestart()
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
          <Popover>
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
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Open in Finder
              </button>
              <button
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                onClick={(e) => {
                  e.stopPropagation()
                  handleCopyPath()
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
              disabled={removeMount.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removeMount.isPending ? 'Removing...' : 'Remove Mount'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function VolumeStatusBadge({ health }: { health: 'ok' | 'missing' }) {
  if (health === 'ok') {
    return (
      <span className="text-[10px] px-1.5 py-0 rounded-full bg-green-500/10 text-green-700 dark:text-green-400">
        OK
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full bg-red-500/10 text-red-700 dark:text-red-400">
      <AlertTriangle className="h-2.5 w-2.5" />
      Missing
    </span>
  )
}
