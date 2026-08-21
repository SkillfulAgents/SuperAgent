import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Pencil, RefreshCw, Trash2, Wrench, X, Loader2 } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
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
  useInvalidateRemoteMcps,
} from '@renderer/hooks/use-remote-mcps'
import { useMcpOAuthListener } from '@renderer/hooks/use-mcp-oauth-listener'
import { useOAuthReconnect } from '@renderer/hooks/use-oauth-reconnect'
import { useDelayedOAuthAbort } from '@renderer/hooks/use-delayed-oauth-abort'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { useQueryClient } from '@tanstack/react-query'
import { OAuthFlowCancel } from './oauth-flow-cancel'

export interface IntegrationRowActionsProps {
  type: 'oauth' | 'mcp'
  id: string
  name: string
  /** Composio toolkit slug. Required for `type === 'oauth'`. */
  toolkit?: string
  /** Tool catalog, listed in the MCP "Tools" dialog. */
  mcpTools?: Array<{ name: string; description?: string }>
  /** Account status for OAuth rows. Shows the Reconnect button when not active. */
  accountStatus?: 'active' | 'expired' | 'revoked'
}

/**
 * Inline action buttons for the connection detail page header: Rename and
 * Delete, plus Reconnect for expired OAuth accounts and Test connection /
 * Tools for MCP servers. Per-agent access and scope/tool policies are managed
 * on the detail page itself, so there are no actions for them here.
 */
export function IntegrationRowActions({ type, id, name, toolkit, mcpTools, accountStatus }: IntegrationRowActionsProps) {
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(name)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mcpStatus, setMcpStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [toolsError, setToolsError] = useState<string | null>(null)
  const [oauthPending, setOauthPending] = useState(false)
  const mcpOAuthPopupRef = useRef<ReturnType<typeof prepareOAuthPopup> | null>(null)
  const showMcpOAuthCancel = useDelayedOAuthAbort(oauthPending)

  // Rename-button ref so dialogs can restore focus to the header after closing.
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const renameAccount = useRenameConnectedAccount()
  const renameMcp = useRenameRemoteMcp()
  const deleteAccount = useDeleteConnectedAccount()
  const deleteMcp = useDeleteRemoteMcp()
  const testMcpConnection = useTestMcpConnection()
  const discoverMcpTools = useDiscoverMcpTools()
  const initiateMcpOAuth = useInitiateMcpOAuth()
  const invalidateRemoteMcps = useInvalidateRemoteMcps()
  const queryClient = useQueryClient()
  const {
    reconnect: oauthReconnect,
    pendingAccountId,
    canCancelPendingReconnect,
    cancelReconnect,
  } = useOAuthReconnect()

  const renamePending = type === 'oauth' ? renameAccount.isPending : renameMcp.isPending
  const deletePending = type === 'oauth' ? deleteAccount.isPending : deleteMcp.isPending
  const oauthReconnectPending = pendingAccountId === id
  const showOAuthReconnectCancel = oauthReconnectPending && canCancelPendingReconnect

  useMcpOAuthListener(oauthPending, ({ success, error }) => {
    mcpOAuthPopupRef.current?.close()
    mcpOAuthPopupRef.current = null
    setOauthPending(false)
    if (success) {
      setMcpStatus({ kind: 'success', message: 'Connected' })
      invalidateRemoteMcps()
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    } else {
      setMcpStatus({ kind: 'error', message: error || 'Reconnect failed' })
    }
  })

  useEffect(() => () => {
    mcpOAuthPopupRef.current?.close()
    mcpOAuthPopupRef.current = null
  }, [])

  const restoreFocus = (e: Event) => {
    e.preventDefault()
    triggerRef.current?.focus()
  }

  const openRename = () => {
    setRenameValue(name)
    setActionError(null)
    setRenameOpen(true)
  }

  const openDelete = () => {
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
    mcpOAuthPopupRef.current = popup
    setMcpStatus(null)
    try {
      const result = await initiateMcpOAuth.mutateAsync({
        mcpId: id,
        electron: !!window.electronAPI,
      })
      if (result.redirectUrl) {
        setOauthPending(true)
        try {
          await popup.navigate(result.redirectUrl)
        } catch (err) {
          setOauthPending(false)
          throw err
        }
      } else {
        popup.close()
        mcpOAuthPopupRef.current = null
        // Non-OAuth MCP (or already authed) — re-test so the button updates.
        await runTestConnection()
      }
    } catch (err) {
      popup.close()
      mcpOAuthPopupRef.current = null
      setMcpStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Reconnect failed',
      })
    }
  }

  const cancelMcpOAuth = () => {
    mcpOAuthPopupRef.current?.close()
    mcpOAuthPopupRef.current = null
    setOauthPending(false)
    setMcpStatus({ kind: 'error', message: 'Reconnect canceled' })
  }

  const runOAuthReconnect = async () => {
    if (!toolkit) return
    setActionError(null)
    await oauthReconnect(id, toolkit)
  }

  const openTools = () => {
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

  const connectionNoun = type === 'oauth' ? 'API connection' : 'MCP server'
  const mcpActionPending =
    testMcpConnection.isPending ||
    discoverMcpTools.isPending ||
    initiateMcpOAuth.isPending ||
    oauthPending

  return (
    <>
      <div className="flex items-center gap-2">
        {type === 'oauth' && accountStatus && accountStatus !== 'active' && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-amber-700 dark:text-amber-400"
              onClick={(e) => { e.stopPropagation(); void runOAuthReconnect() }}
              disabled={oauthReconnectPending}
              data-testid={`integration-row-actions-reconnect-${type}-${id}`}
            >
              {oauthReconnectPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reconnect
            </Button>
            <OAuthFlowCancel
              visible={showOAuthReconnectCancel}
              onCancel={cancelReconnect}
              testId={`integration-row-actions-cancel-reconnect-${type}-${id}`}
            />
          </div>
        )}
        {type === 'mcp' && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8"
              onClick={(e) => {
                e.stopPropagation()
                if (mcpStatus?.kind === 'error') void runReconnect()
                else void runTestConnection()
              }}
              disabled={mcpActionPending}
              data-testid={`integration-row-actions-test-${type}-${id}`}
            >
              {testMcpConnection.isPending || initiateMcpOAuth.isPending || oauthPending ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : mcpStatus?.kind === 'success' ? (
                <span className="mr-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-emerald-500/15">
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                </span>
              ) : mcpStatus?.kind === 'error' ? (
                <span className="mr-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-sm bg-destructive/15">
                  <X className="h-3 w-3 text-destructive" />
                </span>
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
              )}
              {oauthPending ? (
                'Waiting for OAuth...'
              ) : mcpStatus?.kind === 'success' ? (
                mcpStatus.message
              ) : mcpStatus?.kind === 'error' ? (
                <>
                  Reconnect
                  <ArrowUpRight className="h-3 w-3 ml-1" aria-hidden="true" />
                </>
              ) : (
                'Test connection'
              )}
            </Button>
            <OAuthFlowCancel
              visible={showMcpOAuthCancel}
              onCancel={cancelMcpOAuth}
              testId={`integration-row-actions-cancel-mcp-oauth-${id}`}
            />
          </>
        )}
        {type === 'mcp' && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8"
            onClick={(e) => { e.stopPropagation(); openTools() }}
            data-testid={`integration-row-actions-tools-${type}-${id}`}
          >
            <Wrench className="h-3.5 w-3.5 mr-1.5" />
            Tools
          </Button>
        )}
        <Button
          ref={triggerRef}
          type="button"
          size="sm"
          variant="outline"
          className="h-8"
          onClick={(e) => { e.stopPropagation(); openRename() }}
          data-testid={`integration-row-actions-rename-${type}-${id}`}
        >
          <Pencil className="h-3.5 w-3.5 mr-1.5" />
          Rename
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={(e) => { e.stopPropagation(); openDelete() }}
          data-testid={`integration-row-actions-delete-${type}-${id}`}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete
        </Button>
      </div>

      {/* Rename dialog */}
      <Dialog open={renameOpen} onOpenChange={(open) => { if (!renamePending) setRenameOpen(open) }}>
        <DialogContent onClick={(e) => e.stopPropagation()} onCloseAutoFocus={restoreFocus}>
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

      {/* Delete confirmation — global */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!deletePending) {
            setDeleteOpen(open)
            if (!open) setActionError(null)
          }
        }}
      >
        <AlertDialogContent onClick={(e) => e.stopPropagation()} onCloseAutoFocus={restoreFocus}>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {connectionNoun}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes &quot;{name}&quot; and revokes access for every agent using it.
              This action cannot be undone.
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

      {/* Tools dialog */}
      {type === 'mcp' && (
        <Dialog
          open={toolsOpen}
          onOpenChange={(open) => {
            if (!discoverMcpTools.isPending) setToolsOpen(open)
          }}
        >
          <DialogContent
            onClick={(e) => e.stopPropagation()}
            onCloseAutoFocus={restoreFocus}
          >
            <DialogHeader>
              <DialogTitle>Tools for {name}</DialogTitle>
              <DialogDescription>
                {mcpTools && mcpTools.length > 0
                  ? `${mcpTools.length} tool${mcpTools.length === 1 ? '' : 's'} available.`
                  : 'No tools discovered yet. Check for new tools to fetch the catalog.'}
              </DialogDescription>
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
            <DialogFooter className="sm:justify-start">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => { void refreshTools() }}
                disabled={discoverMcpTools.isPending}
              >
                {discoverMcpTools.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                )}
                Check for new tools
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
