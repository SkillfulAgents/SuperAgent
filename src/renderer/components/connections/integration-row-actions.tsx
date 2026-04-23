import { useState } from 'react'
import { Settings, Pencil, Shield, Trash2, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  useDeleteConnectedAccount,
  useRenameConnectedAccount,
} from '@renderer/hooks/use-connected-accounts'
import {
  useDeleteRemoteMcp,
  useRenameRemoteMcp,
} from '@renderer/hooks/use-remote-mcps'
import { ScopePolicyEditor } from '@renderer/components/settings/scope-policy-editor'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'

export interface IntegrationRowActionsProps {
  type: 'oauth' | 'mcp'
  id: string
  name: string
  /** Composio toolkit slug. Required for `type === 'oauth'`. */
  toolkit?: string
  /** Tool catalog, used by the MCP scope editor. Required for `type === 'mcp'`. */
  mcpTools?: Array<{ name: string; description?: string }>
}

export function IntegrationRowActions({ type, id, name, toolkit, mcpTools }: IntegrationRowActionsProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(name)
  const [scopesOpen, setScopesOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const renameAccount = useRenameConnectedAccount()
  const renameMcp = useRenameRemoteMcp()
  const deleteAccount = useDeleteConnectedAccount()
  const deleteMcp = useDeleteRemoteMcp()

  const renamePending = type === 'oauth' ? renameAccount.isPending : renameMcp.isPending
  const deletePending = type === 'oauth' ? deleteAccount.isPending : deleteMcp.isPending

  const openRename = () => {
    setMenuOpen(false)
    setRenameValue(name)
    setActionError(null)
    setRenameOpen(true)
  }

  const openScopes = () => {
    setMenuOpen(false)
    setScopesOpen(true)
  }

  const openDelete = () => {
    setMenuOpen(false)
    setActionError(null)
    setDeleteOpen(true)
  }

  const submitRename = async () => {
    const next = renameValue.trim()
    if (!next || next === name) {
      setRenameOpen(false)
      return
    }
    setActionError(null)
    try {
      if (type === 'oauth') {
        await renameAccount.mutateAsync({ accountId: id, displayName: next })
      } else {
        await renameMcp.mutateAsync({ mcpId: id, name: next })
      }
      setRenameOpen(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Rename failed')
    }
  }

  const submitDelete = async () => {
    setActionError(null)
    try {
      if (type === 'oauth') {
        await deleteAccount.mutateAsync(id)
      } else {
        await deleteMcp.mutateAsync(id)
      }
      setDeleteOpen(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  // The MCP scope editor needs the tool catalog. If missing, hide the option.
  const canEditScopes =
    type === 'oauth' ? !!toolkit : Array.isArray(mcpTools) && mcpTools.length > 0

  return (
    <>
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
            aria-label={`Actions for ${name}`}
            onClick={(e) => e.stopPropagation()}
            data-testid={`integration-row-actions-${type}-${id}`}
          >
            <Settings className="h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="w-40 p-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
            onClick={openRename}
          >
            <Pencil className="h-3.5 w-3.5" />
            Rename
          </button>
          {canEditScopes && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
              onClick={openScopes}
            >
              <Shield className="h-3.5 w-3.5" />
              Edit permissions
            </button>
          )}
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-destructive hover:bg-destructive/10 transition-colors"
            onClick={openDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </PopoverContent>
      </Popover>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={(open) => { if (!renamePending) setRenameOpen(open) }}>
        <DialogContent onClick={(e) => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Rename connection</DialogTitle>
            <DialogDescription>Pick a new name for this connection.</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void submitRename()
              }
            }}
          />
          {actionError && (
            <p className="text-xs text-destructive" role="alert">{actionError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)} disabled={renamePending}>
              Cancel
            </Button>
            <Button onClick={submitRename} disabled={renamePending || !renameValue.trim()}>
              {renamePending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                'Save'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deletePending) {
            setDeleteOpen(open)
            if (!open) setActionError(null)
          }
        }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete &quot;{name}&quot; and revoke access for every agent using it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && (
            <p className="text-xs text-destructive" role="alert">{actionError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void submitDelete()
              }}
              disabled={deletePending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deletePending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Scope editor */}
      {type === 'oauth' && toolkit && scopesOpen && (
        <ScopePolicyEditor
          accountId={id}
          toolkit={toolkit}
          open={scopesOpen}
          onOpenChange={setScopesOpen}
        />
      )}
      {type === 'mcp' && mcpTools && scopesOpen && (
        <ToolPolicyEditor
          mcpId={id}
          mcpName={name}
          tools={mcpTools}
          open={scopesOpen}
          onOpenChange={setScopesOpen}
        />
      )}
    </>
  )
}
