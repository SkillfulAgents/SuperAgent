import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNavigate } from '@tanstack/react-router'
import { Copy, FolderOpen, Loader2, MoreVertical, Pencil, Timer, Trash2 } from 'lucide-react'
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
import { AgentAutoDeleteSelect } from '@renderer/components/settings/auto-delete-select'
import { useDeleteAgent, useRouteAgentId, type ApiAgent } from '@renderer/hooks/use-agents'
import { useAgentPreferences, useUpdateAgentPreferences } from '@renderer/hooks/use-agent-preferences'
import { useSettings } from '@renderer/hooks/use-settings'
import { apiFetch } from '@renderer/lib/api'
import { canUseHostFeatures } from '@renderer/lib/host-features'

interface AgentSettingsPopoverProps {
  agent: ApiAgent
  /** Put the header's InlineEditableTitle into edit mode. */
  onRename: () => void
}

/**
 * Compact agent settings, popover-form: rename (delegates to the inline
 * title), session auto-delete, and delete. Replaced the settings dialog on
 * the agent header; the sidebar context menu still opens the full dialog.
 */
export function AgentSettingsPopover({ agent, onRename }: AgentSettingsPopoverProps) {
  const [open, setOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // Set when Rename is clicked: the popover must not restore focus to the
  // gear on close, or it would steal it from the title input.
  const skipRestoreFocusRef = useRef(false)
  const deleteAgent = useDeleteAgent()
  const { data: agentPrefs } = useAgentPreferences(agent.slug)
  const updatePrefs = useUpdateAgentPreferences(agent.slug)
  const { data: settings } = useSettings()
  const navigate = useNavigate()
  const routeAgentId = useRouteAgentId()
  const [showPathDialog, setShowPathDialog] = useState(false)
  const [agentPath, setAgentPath] = useState('')

  // `open: true` makes the API run the file manager on ITS OWN host — right
  // when the API is this computer, wrong against a remote deployment, where
  // this becomes the copy-the-path action instead (same logic as the sidebar
  // context menu had before this moved here).
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
        toast.success('Agent directory path copied')
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
      setDeleteConfirmOpen(false)
      if (routeAgentId === agent.slug) void navigate({ to: '/' })
    } catch (error) {
      console.error('Failed to delete agent:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete agent')
    } finally {
      setIsDeleting(false)
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            aria-label="Agent settings"
            data-testid="agent-settings-button"
          >
            <MoreVertical className="h-4 w-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-96 p-1.5"
          onCloseAutoFocus={(e) => {
            if (skipRestoreFocusRef.current) {
              e.preventDefault()
              skipRestoreFocusRef.current = false
            }
          }}
          data-testid="agent-settings-popover"
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              skipRestoreFocusRef.current = true
              setOpen(false)
              onRename()
            }}
            data-testid="rename-agent-button"
          >
            <Pencil className="h-4 w-4 shrink-0" />
            Rename agent
          </button>

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
            onClick={() => {
              setOpen(false)
              void handleDirectoryAction()
            }}
            data-testid="open-agent-directory-item"
          >
            {canShowDirectory ? (
              <>
                <FolderOpen className="h-4 w-4 shrink-0" />
                Show Agent Directory
              </>
            ) : (
              <>
                <Copy className="h-4 w-4 shrink-0" />
                Copy Agent Directory Path
              </>
            )}
          </button>

          <div className="flex items-center gap-2 px-2 py-1.5">
            <Timer className="h-4 w-4 shrink-0" />
            <p className="min-w-0 flex-1 text-sm">Session Auto-Delete</p>
            <AgentAutoDeleteSelect
              value={agentPrefs?.autoDeleteInactiveDays}
              appDefault={settings?.app?.autoDeleteInactiveDays}
              onChange={(days) => {
                updatePrefs.mutate({ autoDeleteInactiveDays: days })
              }}
              triggerClassName="h-8 w-auto shrink-0 gap-1 border-none bg-transparent px-1.5 text-sm text-muted-foreground shadow-none hover:text-foreground focus:ring-0 focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="my-1 border-t" />

          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
            onClick={() => {
              setOpen(false)
              setDeleteConfirmOpen(true)
            }}
            data-testid="delete-agent-button"
          >
            <Trash2 className="h-4 w-4 shrink-0" />
            Delete Agent
          </button>
        </PopoverContent>
      </Popover>

      {/* Outside the popover so it survives the popover closing */}
      <AlertDialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Agent</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{agent.name}&quot;? This will permanently delete
              the agent and all its sessions, messages, and data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="confirm-button"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                'Delete'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Clipboard-write fallback: surface the path for manual copying */}
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
