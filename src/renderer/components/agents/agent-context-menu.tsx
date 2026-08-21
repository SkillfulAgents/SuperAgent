
import { useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
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
import { useDeleteAgent, useRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { AgentSettingsDialog } from './agent-settings-dialog'
import { apiFetch } from '@renderer/lib/api'
import { canUseHostFeatures } from '@renderer/lib/host-features'
import { Settings, FolderOpen, Copy, Trash2, LogOut, Move, FolderInput } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Input } from '@renderer/components/ui/input'
import { useUserSettings, useUpdateUserSettings } from '@renderer/hooks/use-user-settings'
import {
  ROOT_FOLDER_ID,
  ROOT_FOLDER_NAME,
  assignAgentToFolder,
  newFolderId,
  sanitizeFolders,
  uniqueFolderName,
} from '@renderer/lib/agent-folders'

interface AgentContextMenuProps {
  agent: ApiAgent
  children: React.ReactNode
  /** Homepage-only controls that should share the agent's single menu surface. */
  additionalOptions?: React.ReactNode
  /** Enables the homepage grid's explicit arrange mode from any agent card. */
  onArrange?: () => void
  /** Let an explicit mobile arrange gesture own touch holds. */
  disableTouchLongPress?: boolean
}

export function AgentContextMenu({
  agent,
  children,
  additionalOptions,
  onArrange,
  disableTouchLongPress,
}: AgentContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showLeaveDialog, setShowLeaveDialog] = useState(false)
  const [showSettingsDialog, setShowSettingsDialog] = useState(false)
  const [showPathDialog, setShowPathDialog] = useState(false)
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [agentPath, setAgentPath] = useState('')
  const [isDeleting, setIsDeleting] = useState(false)
  const [isLeaving, setIsLeaving] = useState(false)
  const deleteAgent = useDeleteAgent()
  const navigate = useNavigate()
  // undefined when the menu is opened off the agent route (e.g. from the sidebar
  // list), so the up-nav only fires when we're actually viewing the agent being
  // deleted/left. Resolves the URL display slug to the canonical id to compare.
  const routeAgentId = useRouteAgentId()
  const { canAdminAgent, isAuthMode } = useUser()
  const queryClient = useQueryClient()
  const isOwner = canAdminAgent(agent.slug)

  // Left-nav folders are a per-user projection (see `agent-folders.ts`), so
  // this is offered for shared agents too — filing one moves it for nobody
  // else. It is also the only way to file an agent on touch, where dragging a
  // row between folders is not a realistic gesture.
  const { data: userSettings } = useUserSettings()
  const updateSettings = useUpdateUserSettings()
  const folders = useMemo(() => sanitizeFolders(userSettings?.agentFolders), [userSettings?.agentFolders])
  const currentFolderId = userSettings?.agentFolderAssignments?.[agent.slug]
  // An assignment naming a folder that no longer exists reads as the default
  // folder, the same way the sidebar renders it.
  const selectedFolderValue =
    currentFolderId && folders.some((f) => f.id === currentFolderId)
      ? currentFolderId
      : ROOT_FOLDER_ID

  // Only the assignment changes: the agent keeps its position in agentOrder, so
  // it lands in the folder wherever its existing place in the list puts it.
  // Both writes below use the updater form: the payload is a whole-field
  // replacement derived from current settings, and the sidebar's drag path
  // writes the same fields. A snapshot captured at click time would silently
  // revert whatever write was still in flight (file A by drag, quickly file B
  // here → A pops back out); the updater resolves against the settled cache.
  const handleMoveToFolder = useCallback((value: string) => {
    updateSettings.mutate((current) => ({
      // assignAgentToFolder treats the default folder as "delete the key".
      agentFolderAssignments: assignAgentToFolder(
        current?.agentFolderAssignments,
        agent.slug,
        value
      ),
    }))
  }, [agent.slug, updateSettings])

  const handleCreateFolderWithAgent = useCallback(() => {
    const name = newFolderName.trim()
    if (!name) return
    const id = newFolderId()
    updateSettings.mutate((current) => {
      const currentFolders = sanitizeFolders(current?.agentFolders)
      return {
        agentFolders: [...currentFolders, { id, name: uniqueFolderName(currentFolders, name) }],
        agentFolderAssignments: assignAgentToFolder(
          current?.agentFolderAssignments,
          agent.slug,
          id
        ),
      }
    })
    setShowNewFolderDialog(false)
    setNewFolderName('')
  }, [agent.slug, newFolderName, updateSettings])

  // `open: true` makes the API run the file manager on ITS OWN host. That is
  // what you want when the API is this computer; against a cloud workspace it
  // asks the deployment to launch `open`/`explorer`/`xdg-open` somewhere nobody
  // is looking. Remotely this becomes the copy-the-path action the web build
  // already uses, which is the part that still works.
  const canShowDirectory = canUseHostFeatures()

  const handleDirectoryAction = useCallback(async () => {
    const res = await apiFetch(`/api/agents/${agent.slug}/open-directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ open: canShowDirectory }),
    })
    if (!canShowDirectory && res.ok) {
      const { path } = await res.json()
      try {
        await navigator.clipboard.writeText(path)
      } catch {
        setAgentPath(path)
        setShowPathDialog(true)
      }
    }
  }, [agent.slug, canShowDirectory])

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      await deleteAgent.mutateAsync(agent.slug)
      setShowDeleteDialog(false)
      if (routeAgentId === agent.slug) {
        void navigate({ to: '/' })
      }
    } catch (error) {
      console.error('Failed to delete agent:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete agent')
    } finally {
      setIsDeleting(false)
    }
  }

  const handleLeave = async () => {
    setIsLeaving(true)
    try {
      const res = await apiFetch(`/api/agents/${agent.slug}/leave`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json()
        console.error('Failed to leave agent:', data.error)
        return
      }
      setShowLeaveDialog(false)
      if (routeAgentId === agent.slug) {
        void navigate({ to: '/' })
      }
      queryClient.invalidateQueries({ queryKey: ['agents'] })
      queryClient.invalidateQueries({ queryKey: ['my-agent-roles'] })
    } catch (error) {
      console.error('Failed to leave agent:', error)
    } finally {
      setIsLeaving(false)
    }
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild disableTouchLongPress={disableTouchLongPress}>
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent>
          {onArrange && (
            <ContextMenuItem
              onClick={() => {
                onArrange()
              }}
              data-testid="arrange-agent-cards-item"
            >
              <Move className="h-4 w-4 mr-2" />
              Arrange
            </ContextMenuItem>
          )}
          {additionalOptions}
          {(onArrange || additionalOptions) && <ContextMenuSeparator />}
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="move-agent-to-folder-trigger">
              <FolderInput className="h-4 w-4 mr-2" />
              Move to Folder
            </ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuRadioGroup
                value={selectedFolderValue}
                onValueChange={handleMoveToFolder}
              >
                <ContextMenuRadioItem
                  value={ROOT_FOLDER_ID}
                  data-testid="move-agent-to-no-folder-item"
                >
                  {ROOT_FOLDER_NAME}
                </ContextMenuRadioItem>
                {folders.map((folder) => (
                  <ContextMenuRadioItem
                    key={folder.id}
                    value={folder.id}
                    data-testid={`move-agent-to-folder-${folder.id}`}
                  >
                    {folder.name}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => {
                  setNewFolderName('')
                  setShowNewFolderDialog(true)
                }}
                data-testid="move-agent-to-new-folder-item"
              >
                New Folder…
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
          <ContextMenuItem
            onClick={() => setShowSettingsDialog(true)}
            data-testid="agent-settings-item"
          >
            <Settings className="h-4 w-4 mr-2" />
            Settings
          </ContextMenuItem>
          {isOwner && (
            <ContextMenuItem
              onClick={handleDirectoryAction}
              data-testid="open-agent-directory-item"
            >
              {canShowDirectory ? (
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
          )}
          {isOwner && (
            <ContextMenuItem
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              onClick={() => setShowDeleteDialog(true)}
              data-testid="delete-agent-item"
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Delete Agent
            </ContextMenuItem>
          )}
          {isAuthMode && !isOwner && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                onClick={() => setShowLeaveDialog(true)}
                data-testid="leave-agent-item"
              >
                <LogOut className="h-4 w-4 mr-2" />
                Leave Agent
              </ContextMenuItem>
            </>
          )}
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

      <AlertDialog open={showLeaveDialog} onOpenChange={setShowLeaveDialog}>
        <AlertDialogContent data-testid="confirm-leave-agent-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to leave &quot;{agent.name}&quot;? You will lose access
              to this agent and its sessions. An owner will need to re-invite you to regain access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeave}
              disabled={isLeaving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-leave-agent-button"
            >
              {isLeaving ? 'Leaving...' : 'Leave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
        <AlertDialogContent data-testid="new-agent-folder-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>New Folder</AlertDialogTitle>
            <AlertDialogDescription>
              Folders organise your left nav only. Shared agents keep their own
              place for everybody else.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleCreateFolderWithAgent()
              }
            }}
            placeholder="Folder name"
            aria-label="Folder name"
            autoFocus
            maxLength={120}
            data-testid="new-agent-folder-name-input"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleCreateFolderWithAgent}
              disabled={!newFolderName.trim()}
              data-testid="confirm-new-agent-folder-button"
            >
              Create &amp; Move
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
