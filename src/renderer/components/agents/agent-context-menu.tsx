
import { useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
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
import { useDeleteAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { useSelection } from '@renderer/context/selection-context'
import { AgentSettingsDialog } from './agent-settings-dialog'
import { apiFetch } from '@renderer/lib/api'
import { isElectron } from '@renderer/lib/env'
import { Settings, FolderOpen, Copy, Trash2 } from 'lucide-react'
import { useCallback } from 'react'

interface AgentContextMenuProps {
  agent: ApiAgent
  children: React.ReactNode
}

export function AgentContextMenu({
  agent,
  children,
}: AgentContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showSettingsDialog, setShowSettingsDialog] = useState(false)
  const [showPathDialog, setShowPathDialog] = useState(false)
  const [agentPath, setAgentPath] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const deleteAgent = useDeleteAgent()
  const { handleAgentDeleted } = useSelection()

  const handleDirectoryAction = useCallback(async () => {
    const res = await apiFetch(`/api/agents/${agent.slug}/open-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open: isElectron() }),
    })
    if (!isElectron() && res.ok) {
      const { path } = await res.json()
      try {
        await navigator.clipboard.writeText(path)
      } catch {
        setAgentPath(path)
        setShowPathDialog(true)
      }
    }
  }, [agent.slug])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteAgent.mutateAsync(agent.slug)
      setShowDeleteDialog(false)
      handleAgentDeleted(agent.slug)
    } catch (error) {
      console.error('Failed to delete agent:', error)
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onClick={() => setShowSettingsDialog(true)}
            data-testid="agent-settings-item"
          >
            <Settings className="h-4 w-4 mr-2" />
            Settings
          </ContextMenuItem>
          <ContextMenuItem
            onClick={handleDirectoryAction}
            data-testid="open-agent-directory-item"
          >
            {isElectron() ? (
              <>
                <FolderOpen className="h-4 w-4 mr-2" />
                Show Agent Directory
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 mr-2" />
                Copy Agent Directory Path
              </>
            )}
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setShowDeleteDialog(true)}
            data-testid="delete-agent-item"
          >
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Agent
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AgentSettingsDialog
        agent={agent}
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent data-testid="confirm-delete-agent-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{agent.name}&quot;? This will permanently
              delete the agent and all its sessions. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-delete-agent-button"
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showPathDialog} onOpenChange={setShowPathDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agent Directory Path</AlertDialogTitle>
            <AlertDialogDescription className="break-all font-mono text-sm select-all">
              {agentPath}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
