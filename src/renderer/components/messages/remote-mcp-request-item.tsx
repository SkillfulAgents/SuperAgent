import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Blocks,
  Check,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Plug,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { DeclineButton } from './decline-button'
import { RequestTitleChip } from './request-title-chip'
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
  debugInitialStatus?: RequestStatus
  debugHideExistingServers?: boolean
  debugServers?: RemoteMcpServer[]
  debugSelectedMcpId?: string
  onComplete: () => void
}

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined' | 'registering' | 'oauth_pending'

function McpSourceIcon({ slug }: { slug: string }) {
  const [failed, setFailed] = useState(false)

  if (!slug || failed) {
    return <Blocks className="h-5 w-5 text-muted-foreground/70" />
  }

  return (
    <img
      src={`${import.meta.env.BASE_URL}service-icons/${slug}.svg`}
      alt=""
      aria-hidden="true"
      className="h-6 w-6 object-contain"
      onError={() => setFailed(true)}
    />
  )
}

export function RemoteMcpRequestItem({
  toolUseId,
  url,
  name,
  reason,
  authHint,
  sessionId,
  agentSlug,
  readOnly,
  debugInitialStatus,
  debugHideExistingServers,
  debugServers,
  debugSelectedMcpId,
  onComplete,
}: RemoteMcpRequestItemProps) {
  const queryClient = useQueryClient()
  const initiateOAuth = useInitiateMcpOAuth()
  const { track } = useAnalyticsTracking()
  const mcpSlug = COMMON_MCP_SERVERS.find((cs) => cs.url === url)?.slug || ''
  const [status, setStatus] = useState<RequestStatus>(debugInitialStatus || 'pending')
  const [error, setError] = useState<string | null>(null)
  const [selectedMcpId, setSelectedMcpId] = useState<string | null>(null)
  const [newName, setNewName] = useState(name || '')
  const [newUrl, setNewUrl] = useState(url)
  const [showTokenInput, setShowTokenInput] = useState(authHint === 'bearer')
  const [bearerToken, setBearerToken] = useState('')
  const [isEditingRegistration, setIsEditingRegistration] = useState(false)
  const [isMcpPickerOpen, setIsMcpPickerOpen] = useState(false)
  const targetUrl = newUrl.trim() || url

  // Fetch existing remote MCP servers
  const { data, isLoading, refetch } = useQuery<{ servers: RemoteMcpServer[] }>({
    queryKey: ['remote-mcps'],
    queryFn: async () => {
      const res = await apiFetch('/api/remote-mcps')
      if (!res.ok) throw new Error('Failed to fetch remote MCPs')
      return res.json()
    },
  })

  const servers = useMemo(() => {
    if (debugServers) return debugServers
    const fetchedServers = Array.isArray(data?.servers) ? data.servers : []
    return debugHideExistingServers ? [] : fetchedServers
  }, [data, debugHideExistingServers, debugServers])
  const matchingServer = useMemo(
    () => servers.find((server) => server.url === targetUrl) || null,
    [servers, targetUrl]
  )
  const activeMcpId = selectedMcpId || matchingServer?.id || null
  const selectedServer = useMemo(
    () => servers.find((server) => server.id === activeMcpId) || matchingServer || null,
    [activeMcpId, matchingServer, servers]
  )
  const connectCardSlug = COMMON_MCP_SERVERS.find((server) => server.url === targetUrl)?.slug || mcpSlug

  useEffect(() => {
    if (debugInitialStatus) {
      setStatus(debugInitialStatus)
    }
  }, [debugInitialStatus])

  useEffect(() => {
    if (debugSelectedMcpId) {
      setSelectedMcpId(debugSelectedMcpId)
    }
  }, [debugSelectedMcpId])

  // Auto-select matching server on first load only
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return
    const matching = servers.find((s) => s.url === targetUrl)
    if (matching) {
      setSelectedMcpId(matching.id)
      hasAutoSelected.current = true
    }
  }, [servers, targetUrl])

  // Handle OAuth completion (shared by Electron IPC and web postMessage)
  const handleOAuthComplete = useCallback((success: boolean, errorMessage?: string) => {
    if (success) {
      setError(null)
      // Refetch servers to find the newly created one
      refetch().then(({ data: refreshedData }) => {
        const refreshedServers = Array.isArray(refreshedData?.servers) ? refreshedData.servers : []
        const newServer = refreshedServers.find((s) => s.url === targetUrl)
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
  }, [refetch, targetUrl])

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

  const startOAuthFlow = async (popup: ReturnType<typeof prepareOAuthPopup>) => {
    try {
      const isElectron = !!window.electronAPI
      const result = await initiateOAuth.mutateAsync({
        name: newName.trim() || url,
        url: targetUrl,
        electron: isElectron,
      })

      if (result.redirectUrl) {
        await popup.navigate(result.redirectUrl)
        setStatus('oauth_pending')
      } else {
        popup.close()
        setError('OAuth initiation did not return a redirect URL')
        setStatus('pending')
      }
    } catch (oauthErr: any) {
      popup.close()
      setError(oauthErr.message || 'Failed to initiate OAuth')
      setStatus('pending')
    }
  }

  const handleRegisterNew = async () => {
    setStatus('registering')
    setError(null)
    track('mcp_added', { url: targetUrl, authType: authHint || (bearerToken ? 'bearer' : 'none'), location: 'session' })

    const popup = prepareOAuthPopup()

    // If agent hinted OAuth, go straight to OAuth flow
    if (authHint === 'oauth') {
      await startOAuthFlow(popup)
      return
    }

    try {
      const response = await apiFetch('/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim() || url,
          url: targetUrl,
          authType: bearerToken ? 'bearer' : 'none',
          accessToken: bearerToken || undefined,
        }),
      })

      const responseData = await response.json()

      if (!response.ok) {
        // Server requires OAuth — automatically initiate OAuth flow
        if (responseData.needsOAuth) {
          await startOAuthFlow(popup)
          return
        }
        // Server requires auth but not OAuth — show bearer token input
        if (responseData.needsAuth) {
          popup.close()
          setShowTokenInput(true)
          setError(responseData.error || 'This MCP server requires authentication.')
          setStatus('pending')
          return
        }
        popup.close()
        throw new Error(responseData.error || 'Failed to register MCP server')
      }

      popup.close()

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
      popup.close()
      setError(err.message || 'Failed to register MCP server')
      setStatus('pending')
    }
  }

  const handleProvide = async () => {
    if (!activeMcpId) return

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
            remoteMcpId: activeMcpId,
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

  const renderSelectedServerCard = () => {
    if (!selectedServer) return null
    const selectedServerSlug = COMMON_MCP_SERVERS.find((server) => server.url === selectedServer.url)?.slug || ''

    return (
      <div className="rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
            <McpSourceIcon slug={selectedServerSlug} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {selectedServer.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {selectedServer.url}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {selectedServer.tools.length} tools
          </span>
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded shrink-0',
              selectedServer.status === 'active'
                ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                : selectedServer.status === 'auth_required'
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                  : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
            )}
          >
            {selectedServer.status === 'active' ? 'connected' : selectedServer.status}
          </span>
        </div>
      </div>
    )
  }

  const renderMcpPicker = () => {
    if (servers.length === 0) return null

    return (
      <>
        <div className="inline-flex items-center gap-1 self-start px-1 py-1 text-xs text-muted-foreground">
          <span>Not the right MCP?</span>
          <button
            type="button"
            onClick={() => setIsMcpPickerOpen((open) => !open)}
            disabled={status !== 'pending'}
            className="inline-flex items-center gap-1 underline underline-offset-2 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span>Select a different one</span>
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                isMcpPickerOpen && 'rotate-180'
              )}
            />
          </button>
        </div>
        {isMcpPickerOpen ? (
          <div className="space-y-1 pb-2">
            {servers.map((server) => (
              <button
                key={server.id}
                type="button"
                onClick={() => {
                  setSelectedMcpId(server.id)
                  setIsMcpPickerOpen(false)
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left transition-colors',
                  server.id === activeMcpId
                    ? 'bg-muted text-foreground'
                    : 'text-foreground hover:bg-muted/60'
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {server.id === activeMcpId ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                  ) : (
                    <span className="h-3.5 w-3.5 shrink-0" />
                  )}
                  <span className="truncate text-sm">{server.name}</span>
                </div>
                <div className="ml-3 flex shrink-0 items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {server.tools.length} tools
                  </span>
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
                    {server.status === 'active' ? 'connected' : server.status}
                  </span>
                </div>
              </button>
            ))}
          </div>
        ) : null}
      </>
    )
  }

  // Completed state
  if (status === 'provided' || status === 'declined') {
    return (
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-center gap-2 p-4">
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
      <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
        <div className="flex items-start gap-3 p-4">
          <div className="flex-1 min-w-0">
            <RequestTitleChip
              className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
              icon={<Plug className="h-4 w-4" />}
            >
              MCP Access Request
            </RequestTitleChip>
            {reason && (
              <p className="mt-4 whitespace-pre-line text-sm text-purple-700 dark:text-purple-300">{reason}</p>
            )}
          </div>
          <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0">Waiting for response</span>
        </div>
      </div>
    )
  }

  // Pending/submitting/registering/oauth_pending state
  return (
    <div className="border rounded-[12px] bg-muted/30 shadow-md text-sm">
      <div className="p-4">
        <div className="flex-1 min-w-0">
          <div>
            <RequestTitleChip
              className="bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200"
              icon={<Plug className="h-4 w-4" />}
            >
              MCP Access Request
            </RequestTitleChip>
            {reason && (
              <p className="mt-4 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              The MCP server will be connected to this agent.
            </p>
          </div>

          <div className="mt-5">
          {/* Register new MCP server */}
          {!matchingServer && (
            status === 'oauth_pending' ? (
              <div className="flex items-center gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Waiting for authorization...
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Complete the OAuth flow in your browser to connect this MCP server.
                  </p>
                </div>
              </div>
            ) : selectedServer ? (
              <div className="space-y-2">
                {renderSelectedServerCard()}
                {renderMcpPicker()}
              </div>
            ) : (
              <div className="space-y-2">
                {isEditingRegistration ? (
                  <div className="space-y-2 rounded-[12px] border border-border bg-white p-4 dark:bg-background">
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="Display name"
                      className="h-8 text-sm"
                      disabled={status !== 'pending'}
                    />
                    <Input
                      value={newUrl}
                      onChange={(e) => setNewUrl(e.target.value)}
                      placeholder="MCP URL"
                      className="h-8 text-sm"
                      disabled={status !== 'pending'}
                    />
                    <div className="flex justify-end gap-2 pt-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setNewName(name || '')
                          setNewUrl(url)
                          setIsEditingRegistration(false)
                        }}
                        disabled={status !== 'pending'}
                        className="border-border text-foreground hover:bg-muted"
                      >
                        Cancel
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => setIsEditingRegistration(false)}
                        disabled={status !== 'pending'}
                        className="min-w-24 bg-foreground text-background hover:bg-foreground/90"
                      >
                        Done
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                        <McpSourceIcon slug={connectCardSlug} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {newName.trim() || name || 'MCP Server'}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {targetUrl}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setIsEditingRegistration(true)}
                        disabled={status !== 'pending'}
                        className="h-8 w-8 border-border p-0 text-muted-foreground hover:bg-muted hover:text-foreground"
                        aria-label="Edit MCP registration details"
                      >
                        <Pencil className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                )}
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
                {renderMcpPicker()}
              </div>
            )
          )}

          {/* Existing MCP servers selection */}
          {isLoading ? (
            <div className="flex items-center gap-2 text-purple-600 dark:text-purple-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading MCP servers...</span>
            </div>
          ) : matchingServer ? (
            <div className="space-y-2">
              {renderSelectedServerCard()}
              {renderMcpPicker()}
            </div>
          ) : null}
          </div>

          {/* Action buttons */}
          {!selectedServer && !matchingServer && status !== 'oauth_pending' ? (
            <div className="mt-6 flex justify-end gap-2">
              <DeclineButton
                onDecline={handleDecline}
                disabled={status !== 'pending' && status !== 'registering'}
                className="border-border text-foreground hover:bg-muted"
              />
              <Button
                onClick={handleRegisterNew}
                disabled={status !== 'pending'}
                size="sm"
                className="min-w-24 bg-foreground text-background hover:bg-foreground/90"
              >
                {status === 'registering' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4" />
                )}
                {status === 'registering' ? <span className="ml-1">Connect</span> : 'Connect'}
              </Button>
            </div>
          ) : null}

          {selectedServer ? (
            <div className="mt-6 flex justify-end gap-2">
              <DeclineButton
                onDecline={handleDecline}
                disabled={status !== 'pending' && status !== 'oauth_pending'}
                className="border-border text-foreground hover:bg-muted"
              />

              <Button
                onClick={handleProvide}
                disabled={!activeMcpId || status !== 'pending'}
                size="sm"
                className="bg-purple-600 hover:bg-purple-700 text-white"
              >
                {status === 'submitting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {status === 'submitting' ? <span className="ml-1">Allow Access</span> : 'Allow Access'}
              </Button>
            </div>
          ) : null}

          {error && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </div>
      </div>
    </div>
  )
}
