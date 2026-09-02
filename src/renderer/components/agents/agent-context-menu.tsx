
import { useState, useCallback, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useAgents, useRouteAgentId, useUpdateAgent, type ApiAgent } from '@renderer/hooks/use-agents'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { useNavTransient } from '@renderer/context/nav-transient-context'
import { DeleteAgentConfirmDialog } from './delete-agent-confirm-dialog'
import { apiFetch } from '@renderer/lib/api'
import {
  Trash2,
  LogOut,
  Move,
  FolderInput,
  Pencil,
  Plus,
  ArrowDownToLine,
  FolderTree,
  ChevronRight,
} from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Input } from '@renderer/components/ui/input'
import { useUserSettings, useUpdateUserSettings, type UserSettingsData } from '@renderer/hooks/use-user-settings'
import { applyAgentOrder } from '@renderer/lib/agent-ordering'
import {
  ROOT_FOLDER_ID,
  ROOT_FOLDER_NAME,
  applyTreeOperation,
  buildFolderSections,
  newFolderId,
  sanitizeFolders,
  sectionsToSettings,
  uniqueFolderName,
  type FolderSection,
} from '@renderer/lib/agent-folders'

interface AgentContextMenuProps {
  agent: ApiAgent
  children: React.ReactNode
  /**
   * Where the surface has an inline-editable title (the agent home), Rename
   * hands off to it instead of opening the rename dialog.
   */
  onRename?: () => void
  /**
   * Where the Share popover is mounted (the agent home), Export opens it on
   * its Export pane directly. Elsewhere the menu navigates to the agent home
   * and the popover opens on arrival.
   */
  onExport?: () => void
  /**
   * Where the workspace folder panel is mounted (the agent home), Agent
   * Directory opens it directly. Elsewhere the menu navigates to the agent
   * home and the panel opens on arrival.
   */
  onOpenDirectory?: () => void
  /** Homepage-only controls that should share the agent's single menu surface. */
  additionalOptions?: React.ReactNode
  /** Enables the homepage grid's explicit arrange mode from any agent card. */
  onArrange?: () => void
  /** Let an explicit mobile arrange gesture own touch holds. */
  disableTouchLongPress?: boolean
}

/**
 * The one agent menu. Every entry point — sidebar row right-click, home card
 * right-click/long-press, breadcrumb right-click, and the agent home's
 * three-dot button — opens this same list, so an action is never only
 * reachable from one of them.
 */
export function AgentContextMenu({
  agent,
  children,
  onRename,
  onExport,
  onOpenDirectory,
  additionalOptions,
  onArrange,
  disableTouchLongPress,
}: AgentContextMenuProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showLeaveDialog, setShowLeaveDialog] = useState(false)
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [newName, setNewName] = useState(agent.name)
  const [isLeaving, setIsLeaving] = useState(false)
  // Hand-offs to another surface on the page (the inline title, the Share
  // popover) wait for the menu to finish closing (onCloseAutoFocus): the menu
  // is modal, so an input mounted while it is still open has its autofocus
  // pulled straight back into the menu by the focus trap, and on close the
  // menu would then restore focus to whatever opened it. Deferring past both
  // leaves focus where the hand-off put it.
  const pendingCloseActionRef = useRef<(() => void) | null>(null)
  const updateAgent = useUpdateAgent()
  const navigate = useNavigate()
  const { setPendingAgentHomeAction } = useNavTransient()
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
  const { data: allAgents } = useAgents()
  const updateSettings = useUpdateUserSettings()
  const folders = useMemo(() => sanitizeFolders(userSettings?.agentFolders), [userSettings?.agentFolders])
  const currentFolderId = userSettings?.agentFolderAssignments?.[agent.slug]
  // An assignment naming a folder that no longer exists reads as the default
  // folder, the same way the sidebar renders it.
  const selectedFolderValue =
    currentFolderId && folders.some((f) => f.id === currentFolderId)
      ? currentFolderId
      : ROOT_FOLDER_ID
  const moveDestinations = useMemo(
    () =>
      [{ id: ROOT_FOLDER_ID, name: ROOT_FOLDER_NAME }, ...folders].filter(
        (dest) => dest.id !== selectedFolderValue
      ),
    [folders, selectedFolderValue]
  )

  // Filing writes the whole canonical tree — the same shape a drag writes —
  // so the two filing paths leave identical settings and the flat agentOrder
  // the home grid, graph and tray read always matches the sidebar's reading
  // order. (An assignment-only write left agentOrder stale until the next
  // drag.) Both writes use the updater form: they resolve against the
  // settings as of when the (scope-serialized) mutation runs, so a filing
  // queued behind an in-flight write cannot revert it. Filing appends to the
  // target folder, matching a drop on the folder's header.
  const buildSections = useCallback(
    (current: UserSettingsData) =>
      buildFolderSections(
        applyAgentOrder(allAgents ?? [], current.agentOrder),
        current.agentFolders,
        current.agentFolderAssignments,
        current.agentListOrder
      ),
    [allAgents]
  )

  const handleMoveToFolder = useCallback((value: string) => {
    // The current folder is not offered, but guard anyway: the agent is
    // already there, so there is nothing to write.
    if (value === selectedFolderValue) return
    updateSettings.mutate((current) =>
      sectionsToSettings(
        applyTreeOperation(buildSections(current), {
          kind: 'placeAgent',
          slug: agent.slug,
          folderId: value,
          index: Number.MAX_SAFE_INTEGER,
        })
      )
    )
  }, [agent.slug, buildSections, selectedFolderValue, updateSettings])

  const handleCreateFolderWithAgent = useCallback(() => {
    const name = newFolderName.trim()
    if (!name) return
    const id = newFolderId()
    updateSettings.mutate((current) => {
      const sections = buildSections(current)
      const currentFolders = sections.filter((s) => !s.isRoot).map((s) => s.folder)
      const withFolder: FolderSection[] = [
        ...sections,
        { folder: { id, name: uniqueFolderName(currentFolders, name) }, isRoot: false, agents: [] },
      ]
      return sectionsToSettings(
        applyTreeOperation(withFolder, {
          kind: 'placeAgent',
          slug: agent.slug,
          folderId: id,
          index: 0,
        })
      )
    })
    setShowNewFolderDialog(false)
    setNewFolderName('')
  }, [agent.slug, buildSections, newFolderName, updateSettings])

  const handleRenameItem = () => {
    if (onRename) {
      pendingCloseActionRef.current = onRename
      return
    }
    setNewName(agent.name)
    setShowRenameDialog(true)
  }

  const handleExportItem = () => {
    if (onExport) {
      pendingCloseActionRef.current = onExport
      return
    }
    // Away from the agent home: go there, and let it open the Export pane
    // once the Share popover is mounted.
    pendingCloseActionRef.current = () => parkAgentHomeAction('export')
  }

  const handleDirectoryItem = () => {
    if (onOpenDirectory) {
      pendingCloseActionRef.current = onOpenDirectory
      return
    }
    // Same hand-off as Export: the folder panel lives on the agent home.
    pendingCloseActionRef.current = () => parkAgentHomeAction('directory')
  }

  // Runs from the close hook, never from the item click: if the agent home is
  // already the page underneath, its effect opens the popover at once, and
  // the still-closing menu then hands focus back to its trigger — which the
  // non-modal Share popover reads as an outside interaction and dismisses.
  // Waiting for the close (and suppressing that focus return) keeps it open.
  const parkAgentHomeAction = (action: 'export' | 'directory') => {
    setPendingAgentHomeAction({ slug: agent.slug, action })
    void navigate({ to: '/agents/$slug', params: { slug: agent.displaySlug } })
  }

  const handleRename = async () => {
    const trimmed = newName.trim()
    if (!trimmed || trimmed === agent.name) {
      setShowRenameDialog(false)
      return
    }
    try {
      await updateAgent.mutateAsync({ slug: agent.slug, name: trimmed })
      setShowRenameDialog(false)
    } catch (error) {
      console.error('Failed to rename agent:', error)
      toast.error('Failed to rename agent', {
        description: error instanceof Error ? error.message : 'Please try again.',
      })
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
        <ContextMenuContent
          data-testid="agent-context-menu"
          // Fixed width so the panel reads the same from every entry point; items
          // stay edge-aligned (text left, chevrons right) rather than inset.
          className="w-52 rounded-xl p-2"
          onCloseAutoFocus={(e) => {
            const action = pendingCloseActionRef.current
            if (!action) return
            pendingCloseActionRef.current = null
            e.preventDefault()
            action()
          }}
        >
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
          {(onArrange || additionalOptions) && <ContextMenuSeparator className="mx-1" />}
          {isOwner && (
            <ContextMenuItem onClick={handleRenameItem} data-testid="rename-agent-item">
              <Pencil className="h-4 w-4 mr-2" />
              Edit Agent
            </ContextMenuItem>
          )}
          {isOwner && (
            <ContextMenuItem onClick={handleExportItem} data-testid="export-agent-item">
              <ArrowDownToLine className="h-4 w-4 mr-2" />
              Export Agent
            </ContextMenuItem>
          )}
          <ContextMenuSeparator className="mx-1" />
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="move-agent-to-folder-trigger">
              <FolderInput className="h-4 w-4 mr-2" />
              Move to Folder
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="rounded-xl p-2">
              {/* Only destinations: the folder the agent is already in is
                  left out rather than shown checked. */}
              {moveDestinations.map((dest) => (
                <ContextMenuItem
                  key={dest.id}
                  onClick={() => handleMoveToFolder(dest.id)}
                  data-testid={
                    dest.id === ROOT_FOLDER_ID
                      ? 'move-agent-to-no-folder-item'
                      : `move-agent-to-folder-${dest.id}`
                  }
                >
                  {dest.name}
                </ContextMenuItem>
              ))}
              {moveDestinations.length > 0 && <ContextMenuSeparator className="mx-1" />}
              <ContextMenuItem
                // Secondary to the destinations above: muted until focused.
                className="text-muted-foreground"
                onClick={() => {
                  setNewFolderName('')
                  setShowNewFolderDialog(true)
                }}
                data-testid="move-agent-to-new-folder-item"
              >
                <Plus className="h-4 w-4 mr-2" />
                New Folder
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
          {isOwner && (
            <ContextMenuItem onClick={handleDirectoryItem} data-testid="open-agent-directory-item">
              <FolderTree className="h-4 w-4 mr-2" />
              Agent Directory
              <ChevronRight className="ml-auto h-4 w-4" />
            </ContextMenuItem>
          )}
          {isOwner && (
            <>
              <ContextMenuSeparator className="mx-1" />
              <ContextMenuItem
                onClick={() => setShowDeleteDialog(true)}
                data-testid="delete-agent-item"
              >
                <Trash2 className="h-4 w-4 mr-2" />
                Delete Agent
              </ContextMenuItem>
            </>
          )}
          {isAuthMode && !isOwner && (
            <>
              <ContextMenuSeparator className="mx-1" />
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

      <DeleteAgentConfirmDialog
        agentSlug={agent.slug}
        agentName={agent.name}
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
      />

      {/* Rename for surfaces without an inline title (sidebar, home cards). */}
      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="overflow-hidden" data-testid="rename-agent-dialog">
          <DialogHeader>
            <DialogTitle>Rename Agent</DialogTitle>
            <DialogDescription>Enter a new name for this agent.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleRename()
            }}
          >
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Agent name"
              aria-label="Agent name"
              autoFocus
              data-testid="rename-agent-name-input"
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowRenameDialog(false)}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={updateAgent.isPending || !newName.trim()}
                data-testid="confirm-rename-agent-button"
              >
                {updateAgent.isPending ? 'Renaming...' : 'Rename'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>


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
    </>
  )
}
