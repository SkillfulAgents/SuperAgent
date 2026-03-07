import { apiFetch } from '@renderer/lib/api'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Check,
  Loader2,
  Plus,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { DeclineButton } from './decline-button'
import { cn } from '@shared/lib/utils/cn'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInitiateMcpOAuth } from '@renderer/hooks/use-remote-mcps'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'

interface RemoteMcpServer {
  id: string
  name: string
  url: string
  authType: string
  status: string
  tools: Array<{ name: string; description?: string }>
}

interface RemoteMcpRequestItemProps {
  toolUseId: string
  url: string
  name?: string
  reason?: string
  authHint?: 'oauth' | 'bearer'
  sessionId: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined' | 'registering' | 'oauth_pending'

export function RemoteMcpRequestItem({
  toolUseId,
  url,
  name,
  reason,
  authHint,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
}: RemoteMcpRequestItemProps) {
  const queryClient = useQueryClient()
  const initiateOAuth = useInitiateMcpOAuth()
  const { track } = useAnalyticsTracking()
  const mcpSlug = COMMON_MCP_SERVERS.find((cs) => cs.url === url)?.slug || ''
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null)
  const [newName, setNewName] = useState(name || '')
  const [showTokenInput, setShowTokenInput] = useState(authHint === 'bearer')
  const [bearerToken, setBearerToken] = useState('')

  // Fetch existing remote MCP servers
  const { data, isLoading, refetch } = useQuery<{ servers: RemoteMcpServer[] }>({
    queryKey: ['remote-mcps'],
    queryFn: async () => {
      const res = await apiFetch('/api/remote-mcps')
      if (!res.ok) throw new Error('Failed to fetch remote MCPs')
      return res.json()
    },
  })

  const servers = useMemo(() => Array.isArray(data?.servers) ? data.servers : [], [data])

  // Auto-select matching server on first load only
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return
    const matching = servers.find((s) => s.url === url)
    if (matching) {
      setSelectedMcpId(matching.id)
      hasAutoSelected.current = true
    }
  }, [servers, url])

  // Handle OAuth completion (shared by Electron IPC and web postMessage)
  const handleOAuthComplete = useCallback((success: boolean, errorMessage?: string) => {
    if (success) {
      setError(null)
      // Refetch servers to find the newly created one
      refetch().then(({ data: refreshedData }) => {
        const refreshedServers = Array.isArray(refreshedData?.servers) ? refreshedData.servers : []
        const newServer = refreshedServers.find((s) => s.url === url)
        if (newServer) {
          setSelectedMcpId(newServer.id)
        }
        setStatus('pending')
      }).catch(() => {
        setStatus('pending')
      })
    } else {
      setError(errorMessage || 'OAuth authorization failed')
      setStatus('pending')
    }
  }, [url, refetch])

  // Listen for MCP OAuth callback from Electron main process
  useEffect(() => {
    if (!window.electronAPI || status !== 'oauth_pending') return

    window.electronAPI.onMcpOAuthCallback((params) => {
      handleOAuthComplete(params.success, params.error ?? undefined)
    })

    return () => {
      window.electronAPI?.removeMcpOAuthCallback()
    }
  }, [status, handleOAuthComplete])

  // Listen for MCP OAuth callback via postMessage (web mode)
  useEffect(() => {
    if (status !== 'oauth_pending') return

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'mcp-oauth-callback') {
        handleOAuthComplete(event.data.success, event.data.error)
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [status, handleOAuthComplete])

  const startOAuthFlow = async () => {
    try {
      const isElectron = !!window.electronAPI
      const result = await initiateOAuth.mutateAsync({
        name: newName.trim() || url,
        url,
        electron: isElectron,
      })

      if (result.redirectUrl) {
        if (window.electronAPI) {
          await window.electronAPI.openExternal(result.redirectUrl)
        } else {
          window.open(result.redirectUrl, '_blank')
        }
        setStatus('oauth_pending')
      } else {
        setError('OAuth initiation did not return a redirect URL')
        setStatus('pending')
      }
    } catch (oauthErr: any) {
      setError(oauthErr.message || 'Failed to initiate OAuth')
      setStatus('pending')
    }
  }

  const handleRegisterNew = async () => {
    setStatus('registering')
    setError(null)
    track('mcp_added', { url, authType: authHint || (bearerToken ? 'bearer' : 'none'), location: 'session' })

    // If agent hinted OAuth, go straight to OAuth flow
    if (authHint === 'oauth') {
      await startOAuthFlow()
      return
    }

    try {
      const response = await apiFetch('/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim() || url,
          url,
          authType: bearerToken ? 'bearer' : 'none',
          accessToken: bearerToken || undefined,
        }),
      })

      const responseData = await response.json()

      if (!response.ok) {
        // Server requires OAuth — automatically initiate OAuth flow
        if (responseData.needsOAuth) {
          await startOAuthFlow()
          return
        }
        // Server requires auth but not OAuth — show bearer token input
        if (responseData.needsAuth) {
          setShowTokenInput(true)
          setError(responseData.error || 'This MCP server requires authentication.')
          setStatus('pending')
          return
        }
        throw new Error(responseData.error || 'Failed to register MCP server')
      }

      // Success — server registered without auth
      const { server } = responseData
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setSelectedMcpId(server.id)

      // Try to discover tools
      await apiFetch(`/api/remote-mcps/${server.id}/discover-tools`, {
        method: 'POST',
      })
      await refetch()

      setStatus('pending')
    } catch (err: any) {
      setError(err.message || 'Failed to register MCP server')
      setStatus('pending')
    }
  }

  const handleProvide = async () => {
    if (!selectedMcpId) return

    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-remote-mcp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            remoteMcpId: selectedMcpId,
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to provide MCP access')
      }

      setStatus('provided')
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps', agentSlug] })
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to provide MCP access')
      setStatus('pending')
    }
  }

  const handleDecline = async (reason?: string) => {
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        `/api/agents/${agentSlug}/sessions/${sessionId}/provide-remote-mcp`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toolUseId,
            decline: true,
            declineReason: reason || 'User declined to provide MCP access',
          }),
        }
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to decline request')
      }

      setStatus('declined')
      onComplete()
    } catch (err: any) {
      setError(err.message || 'Failed to decline request')
      setStatus('pending')
    }
  }

  // Completed state
  if (status === 'provided' || status === 'declined') {
    return (
      <div className="border rounded-md bg-muted/30 text-sm">
        <div className="flex items-center gap-2 px-3 py-2">
          <ServiceIcon
            slug={mcpSlug}
            fallback="mcp"
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'provided' ? 'text-green-500' : 'text-red-500'
            )}
          />
          <span className="font-medium">MCP Server: {name || url}</span>
          <span
            className={cn(
              'ml-auto text-xs',
              status === 'provided' ? 'text-green-600' : 'text-red-600'
            )}
          >
            {status === 'provided' ? 'Access Granted' : 'Declined'}
          </span>
        </div>
      </div>
    )
  }

  // Read-only state for viewers
  if (readOnly) {
    return (
      <div className="border rounded-md bg-purple-50 dark:bg-purple-950 border-purple-200 dark:border-purple-800 text-sm">
        <div className="flex items-center gap-3 p-3">
          <div className="h-8 w-8 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center shrink-0">
            <ServiceIcon slug={mcpSlug} fallback="mcp" className="h-4 w-4 text-purple-600 dark:text-purple-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-purple-900 dark:text-purple-100">
              MCP Server Requested: {name || url}
            </div>
            {reason && (
              <p className="text-sm text-purple-700 dark:text-purple-300 mt-1">{reason}</p>
            )}
          </div>
          <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting/registering/oauth_pending state
  return (
    <div className="border rounded-md bg-purple-50 dark:bg-purple-950 border-purple-200 dark:border-purple-800 text-sm">
      <div className="flex items-start gap-3 p-3">
        <div className="h-8 w-8 rounded-full bg-purple-100 dark:bg-purple-900 flex items-center justify-center shrink-0">
          <ServiceIcon slug={mcpSlug} fallback="mcp" className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        </div>

        <div className="flex-1 min-w-0 space-y-3">
          <div>
            <div className="font-medium text-purple-900 dark:text-purple-100">
              MCP Server Requested: {name || url}
            </div>
            <p className="text-xs text-purple-600 dark:text-purple-400 mt-0.5 truncate">{url}</p>
            {reason && (
              <p className="text-sm text-purple-700 dark:text-purple-300 mt-1">{reason}</p>
            )}
          </div>

          {/* Existing MCP servers selection */}
          {isLoading ? (
            <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading MCP servers...</span>
            </div>
          ) : servers.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                Select an MCP server to provide:
              </p>
              <div className="space-y-1">
                {servers.map((server) => (
                  <div
                    key={server.id}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded border cursor-pointer transition-colors',
                      selectedMcpId === server.id
                        ? 'bg-purple-100 dark:bg-purple-900 border-purple-300 dark:border-purple-700'
                        : 'bg-white dark:bg-purple-950 border-purple-100 dark:border-purple-800 hover:border-purple-200 dark:hover:border-purple-700',
                      status !== 'pending' && 'opacity-50 cursor-not-allowed'
                    )}
                    onClick={() => status === 'pending' && setSelectedMcpId(server.id)}
                  >
                    <div className="flex-1 min-w-0">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      <span className="text-xs text-purple-500 dark:text-purple-400 ml-2">{server.url}</span>
                    </div>
                    <span
                      className={cn(
                        'text-xs px-1.5 py-0.5 rounded shrink-0',
                        server.status === 'active'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                          : server.status === 'auth_required'
                          ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                      )}
                    >
                      {server.status}
                    </span>
                    <span className="text-xs text-purple-400 dark:text-purple-500">
                      {server.tools.length} tools
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Register new MCP server */}
          {!servers.find((s) => s.url === url) && (
            status === 'oauth_pending' ? (
              <div className="flex items-center gap-3 p-2 rounded border border-purple-200 dark:border-purple-700 bg-purple-50 dark:bg-purple-900/50">
                <Loader2 className="h-4 w-4 animate-spin text-purple-600 dark:text-purple-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-purple-900 dark:text-purple-100">
                    Waiting for authorization...
                  </p>
                  <p className="text-xs text-purple-600 dark:text-purple-400">
                    Complete the OAuth flow in your browser to connect this MCP server.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                  Register this MCP server:
                </p>
                <div className="flex gap-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Display name"
                    className="h-8 text-sm flex-1"
                    disabled={status !== 'pending'}
                  />
                  <Button
                    onClick={handleRegisterNew}
                    disabled={status !== 'pending'}
                    variant="outline"
                    size="sm"
                    className="border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900"
                  >
                    {status === 'registering' ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <Plus className="h-4 w-4 mr-1" />
                    )}
                    Register
                  </Button>
                </div>
                {showTokenInput && (
                  <Input
                    type="password"
                    value={bearerToken}
                    onChange={(e) => setBearerToken(e.target.value)}
                    placeholder="Bearer token"
                    className="h-8 text-sm"
                    disabled={status !== 'pending'}
                  />
                )}
              </div>
            )
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={handleProvide}
              disabled={!selectedMcpId || status !== 'pending'}
              size="sm"
              className="bg-purple-600 hover:bg-purple-700 text-white"
            >
              {status === 'submitting' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              <span className="ml-1">Grant Access</span>
            </Button>

            <DeclineButton
              onDecline={handleDecline}
              disabled={status !== 'pending' && status !== 'oauth_pending'}
              className="border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-300 hover:bg-purple-100 dark:hover:bg-purple-900"
            />
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <p className="text-xs text-purple-600 dark:text-purple-400">
            The MCP server will be connected to this agent.
          </p>
        </div>
      </div>
    </div>
  )
}
