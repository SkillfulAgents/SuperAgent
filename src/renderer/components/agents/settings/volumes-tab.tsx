import { useAgentMounts, useAddMount, useRemoveMount } from '@renderer/hooks/use-mounts'
import { Loader2, HardDrive, Trash2, AlertTriangle, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { useState } from 'react'
import { apiFetch } from '@renderer/lib/api'

interface VolumesTabProps {
  agentSlug: string
}

export function VolumesTab({ agentSlug }: VolumesTabProps) {
  const { data: mounts, isLoading, refetch } = useAgentMounts(agentSlug)
  const addMount = useAddMount()
  const removeMount = useRemoveMount()
  const [pendingRestart, setPendingRestart] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)

  const handleAddMount = async () => {
    const dirPath = await window.electronAPI?.openDirectory()
    if (!dirPath) return

    await addMount.mutateAsync({ agentSlug, hostPath: dirPath })
    setPendingRestart(true)
  }

  const handleRemove = async (mountId: string) => {
    await removeMount.mutateAsync({ agentSlug, mountId })
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

  if (isLoading) {
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

      {pendingRestart && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
          <RefreshCw className={`h-4 w-4 text-amber-600 shrink-0 ${isRestarting ? 'animate-spin' : ''}`} />
          <span className="text-sm text-amber-800 dark:text-amber-200 flex-1">
            Restart required for mount changes to take effect.
          </span>
          <Button size="sm" variant="outline" onClick={handleRestart} disabled={isRestarting}>
            {isRestarting ? 'Restarting...' : 'Restart'}
          </Button>
        </div>
      )}

      {(!mounts || mounts.length === 0) ? (
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
          {mounts.map((mount) => (
            <div
              key={mount.id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{mount.folderName}</span>
                  {mount.health === 'ok' ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-300">
                      OK
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
                      <AlertTriangle className="h-2.5 w-2.5" />
                      Missing
                    </span>
                  )}
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
                onClick={() => handleRemove(mount.id)}
                disabled={removeMount.isPending}
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
        onClick={handleAddMount}
        disabled={addMount.isPending}
      >
        {addMount.isPending ? (
          <Loader2 className="h-4 w-4 animate-spin mr-2" />
        ) : (
          <Plus className="h-4 w-4 mr-2" />
        )}
        Add Mount
      </Button>
    </div>
  )
}
