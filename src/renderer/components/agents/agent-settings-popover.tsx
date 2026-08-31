import { useCallback, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Copy, FolderOpen, MoreVertical, Pencil, Timer, Trash2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { AgentAutoDeleteSelect } from '@renderer/components/settings/auto-delete-select'
import { DeleteAgentConfirmDialog } from '@renderer/components/agents/delete-agent-confirm-dialog'
import { type ApiAgent } from '@renderer/hooks/use-agents'
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
  // Set when Rename is clicked: the popover must not restore focus to the
  // gear on close, or it would steal it from the title input.
  const skipRestoreFocusRef = useRef(false)
  const { data: agentPrefs } = useAgentPreferences(agent.slug)
  const updatePrefs = useUpdateAgentPreferences(agent.slug)
  const { data: settings } = useSettings()
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
          className="w-96 p-1"
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

          <div className="-mx-1 my-1 border-t" />

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
      <DeleteAgentConfirmDialog
        agentSlug={agent.slug}
        agentName={agent.name}
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
      />

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
