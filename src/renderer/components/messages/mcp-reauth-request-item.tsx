import { useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@renderer/components/ui/button'
import { LoginButton } from '@renderer/components/connections/login-button'
import { Input } from '@renderer/components/ui/input'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useMcpLoginWindow } from '@renderer/hooks/use-mcp-login-window'
import { useRemoteMcps, useInitiateMcpOAuth } from '@renderer/hooks/use-remote-mcps'
import { apiFetch } from '@renderer/lib/api'
import { dismissReauthRequest } from '@renderer/lib/reauth-dismiss'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { DeclineButton } from './decline-button'
import { RequestItemActions } from './request-item-actions'
import { RequestItemShell } from './request-item-shell'
import { RemoteMcpRequestItem } from './remote-mcp-request-item'

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
  const { data: ownMcps } = useRemoteMcps()
  // The list is owner-scoped, whereas the single-server endpoint also allows admins.
  const isOwner = ownMcps?.servers.some((server) => server.id === mcpId)
  const loginWindow = useMcpLoginWindow(({ success, error: oauthError }) => {
    loginWindow.close()
    if (success) {
      setError(null)
      finish()
    } else {
      setError(oauthError || 'MCP reconnection failed')
    }
  })
  // The bearer and no-auth branches reconnect without a login window.
  const [submitting, setSubmitting] = useState(false)
  const pending = submitting || loginWindow.pending
  const [loadingReplacement, setLoadingReplacement] = useState(false)
  const [replacementUrl, setReplacementUrl] = useState<string | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [bearerToken, setBearerToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const serviceSlug = useMemo(
    () => COMMON_MCP_SERVERS.find((server) => server.displayName === mcpName)?.slug,
    [mcpName],
  )
  const canReconnect = !readOnly && isOwner === true
  // See the account twin: the card blocks every session of the agent, so a
  // viewer who cannot reconnect still needs a way to let the agent move on.
  const canDismiss = !readOnly

  const finish = () => {
    queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
    queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
    onComplete()
  }

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

    if (authType === 'oauth') {
      try {
        await loginWindow.open(() => initiateOAuth.mutateAsync({
          mcpId,
          electron: !!window.electronAPI,
        }))
      } catch (reconnectError) {
        setError(reconnectError instanceof Error ? reconnectError.message : 'MCP reconnection failed')
      }
      return
    }

    setSubmitting(true)
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
      setSubmitting(false)
    }
  }

  const replace = async () => {
    setLoadingReplacement(true)
    setError(null)
    try {
      const response = await apiFetch(`/api/agents/${agentSlug}/reauth-request/${proxyRequestId}/replace-mcp`)
      if (!response.ok) throw new Error(await parseError(response, 'Failed to load replacement connections'))
      const data = await response.json() as { url?: string }
      setReplacementUrl(data.url ?? '')
    } catch (replacementError) {
      setError(replacementError instanceof Error ? replacementError.message : 'Failed to load replacement connections')
    } finally {
      setLoadingReplacement(false)
    }
  }

  if (replacementUrl !== null && !readOnly) {
    return (
      <RemoteMcpRequestItem
        toolUseId={proxyRequestId}
        url={replacementUrl}
        name={mcpName}
        reason={`Replace ${mcpName} connection`}
        authHint={authType === 'none' ? undefined : authType}
        sessionId={sessionId}
        agentSlug={agentSlug}
        replacement={{ requestId: proxyRequestId, onCancel: () => setReplacementUrl(null) }}
        onComplete={onComplete}
      />
    )
  }

  return (
    <RequestItemShell
      title={`This request needs ${mcpName}, which requires re-authentication.`}
      subtitle={isOwner === false
        ? 'Replace it with a connection you own to continue, or dismiss this request.'
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
            disabled={pending || dismissing || loadingReplacement}
            label="Dismiss"
            data-testid="mcp-reauth-dismiss-btn"
          />
          <Button
            type="button"
            size="xs"
            variant={canReconnect ? 'outline' : 'default'}
            onClick={() => void replace()}
            loading={loadingReplacement}
            disabled={pending || dismissing || loadingReplacement}
            data-testid="mcp-reauth-replace-btn"
          >
            Replace connection
          </Button>
          {canReconnect && (
            <LoginButton
              type="button"
              size="xs"
              icon={<RefreshCw />}
              label={authType === 'none' ? 'Retry' : 'Reconnect'}
              pendingLabel="Reconnecting…"
              pending={pending}
              canCancel={loginWindow.canCancel}
              onCancel={loginWindow.close}
              cancelSide="left"
              onClick={() => void reconnect()}
              disabled={dismissing || loadingReplacement || (authType === 'bearer' && !bearerToken.trim())}
              data-testid="mcp-reauth-reconnect-btn"
            />
          )}
        </RequestItemActions>
      )}
      <span className="sr-only">MCP proxy request {proxyRequestId}</span>
    </RequestItemShell>
  )
}
