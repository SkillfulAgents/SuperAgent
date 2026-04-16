import { Loader2, HardDrive, Trash2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useVolumesManager } from '@renderer/hooks/use-mounts'
import { VolumeStatusBadge } from '../volume-status-badge'

interface VolumesTabProps {
  agentSlug: string
}

export function VolumesTab({ agentSlug }: VolumesTabProps) {
  const vm = useVolumesManager(agentSlug)

  if (vm.isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Mounted folders give the agent direct read-write access to directories on your machine.
      </p>

      {vm.pendingRestart && (
        <div className="flex flex-col gap-1 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
          <div className="flex items-center gap-2">
            <RefreshCw className={`h-4 w-4 text-amber-600 shrink-0 ${vm.isRestarting ? 'animate-spin' : ''}`} />
            <span className="text-sm text-amber-800 dark:text-amber-200 flex-1">
              Restart required for mount changes to take effect.
            </span>
            <Button size="sm" variant="outline" onClick={vm.handleRestart} disabled={vm.isRestarting}>
              {vm.isRestarting ? 'Restarting...' : 'Restart'}
            </Button>
          </div>
          {vm.restartError && (
            <span className="text-xs text-destructive pl-6" role="alert">
              {vm.restartError}
            </span>
          )}
        </div>
      )}

      {vm.mounts.length === 0 ? (
        <div className="text-center py-8">
          <HardDrive className="h-8 w-8 mx-auto text-muted-foreground mb-3" />
          <p className="text-sm text-muted-foreground">
            No folders are mounted.
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Mount a folder to give the agent direct access to files on your machine.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {vm.mounts.map((mount) => (
            <div
              key={mount.id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{mount.folderName}</span>
                  <VolumeStatusBadge health={mount.health} />
                </div>
                <div className="text-xs text-muted-foreground font-mono truncate" title={mount.hostPath}>
                  {mount.hostPath}
                </div>
                <div className="text-xs text-muted-foreground font-mono">
                  → {mount.containerPath}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => vm.handleRemove(mount.id)}
                disabled={vm.isRemovingMount}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={vm.handleAddMount}
        disabled={vm.isAddingMount}
      >
        {vm.isAddingMount ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Plus className="h-4 w-4 mr-2" />
        )}
        Add Mount
      </Button>
    </div>
  )
}
