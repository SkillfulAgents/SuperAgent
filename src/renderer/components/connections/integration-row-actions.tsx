import { useEffect, useState } from 'react'
import { Check, Pencil, RefreshCw, Settings, Shield, Trash2, Wrench, X, Loader2 } from 'lucide-react'
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
  useDiscoverMcpTools,
  useInitiateMcpOAuth,
  useRenameRemoteMcp,
  useTestMcpConnection,
} from '@renderer/hooks/use-remote-mcps'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
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
  const [toolsOpen, setToolsOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mcpStatus, setMcpStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)

  const renameAccount = useRenameConnectedAccount()
  const renameMcp = useRenameRemoteMcp()
  const deleteAccount = useDeleteConnectedAccount()
  const deleteMcp = useDeleteRemoteMcp()
  const testMcpConnection = useTestMcpConnection()
  const discoverMcpTools = useDiscoverMcpTools()
  const initiateMcpOAuth = useInitiateMcpOAuth()

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

  const runTestConnection = async () => {
    setMcpStatus(null)
    try {
      const result = await testMcpConnection.mutateAsync(id)
      if (result.success) {
        setMcpStatus({ kind: 'success', message: 'Connection OK' })
      } else {
        setMcpStatus({ kind: 'error', message: result.error ?? 'Connection failed' })
      }
    } catch (err) {
      setMcpStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Test connection failed',
      })
    }
  }

  const runReconnect = async () => {
    const popup = prepareOAuthPopup()
    try {
      const result = await initiateMcpOAuth.mutateAsync({
        mcpId: id,
        electron: !!window.electronAPI,
      })
      if (result.redirectUrl) {
        await popup.navigate(result.redirectUrl)
      } else {
        popup.close()
        // Non-OAuth MCP (or already authed) — re-test so the button updates.
        await runTestConnection()
      }
    } catch (err) {
      popup.close()
      setMcpStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Reconnect failed',
      })
    }
  }

  const openTools = () => {
    setMenuOpen(false)
    setToolsError(null)
    setToolsOpen(true)
  }

  const refreshTools = async () => {
    setToolsError(null)
    try {
      await discoverMcpTools.mutateAsync(id)
    } catch (err) {
      setToolsError(err instanceof Error ? err.message : 'Discover tools failed')
    }
  }

  useEffect(() => {
    if (!menuOpen) setMcpStatus(null)
  }, [menuOpen])

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
          {type === 'mcp' && (
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
              onClick={openTools}
            >
              <Wrench className="h-3.5 w-3.5" />
              Discover tools
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
          {type === 'mcp' && (
            <>
              <div className="my-1 h-px bg-border" role="separator" />
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors disabled:opacity-50"
                onClick={() => {
                  if (mcpStatus?.kind === 'error') void runReconnect()
                  else void runTestConnection()
                }}
                disabled={
                  testMcpConnection.isPending ||
                  discoverMcpTools.isPending ||
                  initiateMcpOAuth.isPending
                }
              >
                {testMcpConnection.isPending || initiateMcpOAuth.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : mcpStatus?.kind === 'success' ? (
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-emerald-500/15">
                    <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                  </span>
                ) : mcpStatus?.kind === 'error' ? (
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-destructive/15">
                    <X className="h-3 w-3 text-destructive" />
                  </span>
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {mcpStatus?.kind === 'success'
                  ? 'Connected'
                  : mcpStatus?.kind === 'error'
                    ? 'Reconnect'
                    : 'Test connection'}
              </button>
            </>
          )}
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

      {/* Discover tools dialog */}
      {type === 'mcp' && (
        <Dialog
          open={toolsOpen}
          onOpenChange={(open) => {
            if (!discoverMcpTools.isPending) setToolsOpen(open)
          }}
        >
          <DialogContent hideClose onClick={(e) => e.stopPropagation()}>
            <DialogHeader>
              <div className="flex items-start justify-between gap-2">
                <div className="space-y-1.5">
                  <DialogTitle>Tools for {name}</DialogTitle>
                  <DialogDescription>
                    {mcpTools && mcpTools.length > 0
                      ? `${mcpTools.length} tool${mcpTools.length === 1 ? '' : 's'} available.`
                      : 'No tools discovered yet. Refresh to fetch the catalog.'}
                  </DialogDescription>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  onClick={() => { void refreshTools() }}
                  disabled={discoverMcpTools.isPending}
                  aria-label="Refresh tools"
                >
                  {discoverMcpTools.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </DialogHeader>
            <div className="max-h-[50vh] overflow-y-auto py-1">
              {mcpTools && mcpTools.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {mcpTools.map((tool) => (
                    <span
                      key={tool.name}
                      className="rounded-md border bg-muted/50 px-2 py-1 text-[11px] text-foreground"
                    >
                      {tool.name}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  No tools to show.
                </p>
              )}
            </div>
            {toolsError && (
              <p className="text-xs text-destructive" role="alert">{toolsError}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
