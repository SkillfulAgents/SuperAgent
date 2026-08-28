import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useCanManageRemoteMcp, useInitiateMcpOAuth } from '@renderer/hooks/use-remote-mcps'
import { useMcpOAuthListener } from '@renderer/hooks/use-mcp-oauth-listener'
import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { dismissReauthRequest } from '@renderer/lib/reauth-dismiss'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { DeclineButton } from './decline-button'
import { RequestItemActions } from './request-item-actions'
import { RequestItemShell } from './request-item-shell'

interface McpReauthRequestItemProps {
  proxyRequestId: string
  mcpId: string
  mcpName: string
  authType: 'none' | 'oauth' | 'bearer'
  sessionId?: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

export function McpReauthRequestItem({
  proxyRequestId,
  mcpId,
  mcpName,
  authType,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: McpReauthRequestItemProps) {
  const queryClient = useQueryClient()
  const initiateOAuth = useInitiateMcpOAuth()
  const { data: canManage } = useCanManageRemoteMcp(mcpId)
  const [pending, setPending] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [bearerToken, setBearerToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const popupRef = useRef<ReturnType<typeof prepareOAuthPopup> | null>(null)
  const serviceSlug = useMemo(
    () => COMMON_MCP_SERVERS.find((server) => server.displayName === mcpName)?.slug,
    [mcpName],
  )
  const canReconnect = !readOnly && canManage === true
  // See the account twin: the card blocks every session of the agent, so a
  // viewer who cannot reconnect still needs a way to let the agent move on.
  const canDismiss = !readOnly

  const finish = () => {
    queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
    queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    onComplete()
  }

  useMcpOAuthListener(pending && authType === 'oauth', ({ success, error: oauthError }) => {
    popupRef.current?.close()
    popupRef.current = null
    setPending(false)
    if (success) {
      setError(null)
      finish()
    } else {
      setError(oauthError || 'MCP reconnection failed')
    }
  })

  useEffect(() => () => {
    popupRef.current?.close()
    popupRef.current = null
  }, [])

  const dismiss = async (reason?: string) => {
    setError(null)
    setDismissing(true)
    try {
      await dismissReauthRequest({ agentSlug, requestId: proxyRequestId, reason })
      onComplete()
    } catch (dismissError) {
      setError(dismissError instanceof Error ? dismissError.message : 'Failed to dismiss the request')
    } finally {
      setDismissing(false)
    }
  }

  const parseError = async (response: Response, fallback: string) => {
    const body = await response.json().catch(() => ({})) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : fallback
  }

  const reconnect = async () => {
    setError(null)
    setPending(true)

    if (authType === 'oauth') {
      const popup = prepareOAuthPopup()
      popupRef.current = popup
      try {
        const result = await initiateOAuth.mutateAsync({
          mcpId,
          electron: !!window.electronAPI,
        })
        await popup.navigate(result.redirectUrl)
      } catch (reconnectError) {
        popup.close()
        popupRef.current = null
        setPending(false)
        setError(reconnectError instanceof Error ? reconnectError.message : 'MCP reconnection failed')
      }
      return
    }

    try {
      if (authType === 'bearer') {
        const patchResponse = await apiFetch(`/api/remote-mcps/${mcpId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken: bearerToken.trim() }),
        })
        if (!patchResponse.ok) {
          throw new Error(await parseError(patchResponse, 'Failed to update the bearer token'))
        }
      }

      const discoverResponse = await apiFetch(`/api/remote-mcps/${mcpId}/discover-tools`, {
        method: 'POST',
      })
      if (!discoverResponse.ok) {
        throw new Error(await parseError(discoverResponse, 'The MCP server is still unavailable'))
      }
      finish()
    } catch (reconnectError) {
      setError(reconnectError instanceof Error ? reconnectError.message : 'MCP reconnection failed')
    } finally {
      setPending(false)
    }
  }

  return (
    <RequestItemShell
      title={`This request needs ${mcpName}, which requires re-authentication.`}
      subtitle={canManage === false
        ? 'Only the connection owner or an administrator can reconnect it. Dismiss to let the agent move on without it.'
        : 'Reconnect to continue. The original MCP request will resume automatically.'}
      icon={<ServiceIcon slug={serviceSlug} fallback="mcp" className="h-4 w-4" />}
      theme="orange"
      sessionId={sessionId}
      agentSlug={agentSlug}
      readOnly={canDismiss ? false : {}}
      waitingText="Waiting for reconnection"
      error={error}
      data-testid="mcp-reauth-request"
      data-auth-type={authType}
    >
      {canReconnect && authType === 'bearer' && (
        <Input
          type="password"
          value={bearerToken}
          onChange={(event) => setBearerToken(event.target.value)}
          placeholder="New bearer token"
          disabled={pending}
          data-testid="mcp-reauth-token-input"
        />
      )}
      {canDismiss && (
        <RequestItemActions>
          <DeclineButton
            onDecline={(reason) => { void dismiss(reason) }}
            disabled={pending || dismissing}
            label="Dismiss"
            data-testid="mcp-reauth-dismiss-btn"
          />
          {canReconnect && (
            <Button
              type="button"
              size="xs"
              onClick={() => void reconnect()}
              disabled={pending || dismissing || (authType === 'bearer' && !bearerToken.trim())}
              data-testid="mcp-reauth-reconnect-btn"
            >
              {pending ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              {pending ? 'Reconnecting…' : authType === 'none' ? 'Retry' : 'Reconnect'}
            </Button>
          )}
        </RequestItemActions>
      )}
      <span className="sr-only">MCP proxy request {proxyRequestId}</span>
    </RequestItemShell>
  )
}
