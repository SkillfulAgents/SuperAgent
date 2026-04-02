import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Loader2,
  Plus,
  Plug,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'
import { DeclineButton } from './decline-button'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { cn } from '@shared/lib/utils/cn'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInitiateMcpOAuth } from '@renderer/hooks/use-remote-mcps'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { type RemoteMcpServer, getMcpServiceKey, McpSourceIcon, McpServerCard } from './mcp-server-card'
import { McpServicePicker } from './mcp-service-picker'

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
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState(name || '')
  const [newUrl, setNewUrl] = useState(url)
  const [showTokenInput, setShowTokenInput] = useState(authHint === 'bearer')
  const [bearerToken, setBearerToken] = useState('')
  const [isMcpPickerOpen, setIsMcpPickerOpen] = useState(false)
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null)
  const [editMcpName, setEditMcpName] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  const [menuOpenMcpId, setMenuOpenMcpId] = useState<string | null>(null)
  const [policyEditorMcp, setPolicyEditorMcp] = useState<{ id: string; name: string; tools: Array<{ name: string; description?: string }> } | null>(null)
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

  const servers = useMemo(() => Array.isArray(data?.servers) ? data.servers : [], [data])
  const matchingServer = useMemo(
    () => servers.find((server) => server.url === targetUrl) || null,
    [servers, targetUrl]
  )
  const targetServiceKey = useMemo(() => getMcpServiceKey(targetUrl), [targetUrl])
  const targetServiceServers = useMemo(
    () => servers.filter((server) => getMcpServiceKey(server.url) === targetServiceKey),
    [servers, targetServiceKey]
  )
  const primarySelectedMcpId = selectedMcpIds.values().next().value as string | undefined
  const activeMcpId = primarySelectedMcpId || matchingServer?.id || targetServiceServers[0]?.id || null
  const selectedServer = useMemo(() => {
    if (activeMcpId) {
      const explicitSelection = servers.find((server) => server.id === activeMcpId)
      if (explicitSelection) return explicitSelection
    }
    return matchingServer || targetServiceServers[0] || null
  }, [activeMcpId, matchingServer, servers, targetServiceServers])
  const selectedServiceKey = useMemo(
    () => (selectedServer ? getMcpServiceKey(selectedServer.url) : targetServiceKey),
    [selectedServer, targetServiceKey]
  )
  const displayedServiceServers = useMemo(
    () => servers.filter((server) => getMcpServiceKey(server.url) === selectedServiceKey),
    [selectedServiceKey, servers]
  )
  const connectCardSlug = COMMON_MCP_SERVERS.find((server) => server.url === targetUrl)?.slug || mcpSlug
  const selectedMcpIdsForProvide = useMemo(() => {
    if (selectedMcpIds.size > 0) return Array.from(selectedMcpIds)
    if (displayedServiceServers.length <= 1 && activeMcpId) return [activeMcpId]
    return []
  }, [activeMcpId, displayedServiceServers.length, selectedMcpIds])
  const pickerServiceOptions = useMemo(() => {
    const grouped = new Map<
      string,
      {
        serviceKey: string
        displayName: string
        slug: string
        servers: RemoteMcpServer[]
        hasActiveServer: boolean
      }
    >()

    for (const server of servers) {
      const serviceKey = getMcpServiceKey(server.url)
      const commonServer = COMMON_MCP_SERVERS.find((candidate) => candidate.url === server.url)
      const existing = grouped.get(serviceKey)

      if (existing) {
        existing.servers.push(server)
        existing.hasActiveServer = existing.hasActiveServer || server.status === 'active'
        continue
      }

      grouped.set(serviceKey, {
        serviceKey,
        displayName: commonServer?.displayName || server.name,
        slug: commonServer?.slug || '',
        servers: [server],
        hasActiveServer: server.status === 'active',
      })
    }

    return Array.from(grouped.values())
  }, [servers])

  // Auto-select matching server on first load only
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return
    const initialSelection = servers.find((server) => server.url === targetUrl) || targetServiceServers[0]
    if (initialSelection) {
      setSelectedMcpIds(new Set([initialSelection.id]))
      hasAutoSelected.current = true
    }
  }, [servers, targetServiceServers, targetUrl])

  // Handle OAuth completion (shared by Electron IPC and web postMessage)
  const handleOAuthComplete = useCallback((success: boolean, errorMessage?: string) => {
    if (success) {
      setError(null)
      // Refetch servers to find the newly created one
      refetch().then(({ data: refreshedData }) => {
        const refreshedServers = Array.isArray(refreshedData?.servers) ? refreshedData.servers : []
        const newServer = refreshedServers.find((s) => s.url === targetUrl)
        if (newServer) {
          setSelectedMcpIds(new Set([newServer.id]))
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
    } catch (oauthErr: unknown) {
      popup.close()
      setError(oauthErr instanceof Error ? oauthErr.message : 'Failed to initiate OAuth')
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
      setSelectedMcpIds(new Set([server.id]))

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

  const handleConnectAnother = async () => {
    const nameToUse = selectedServer ? selectedServer.name : newName
    const urlToUse = selectedServer ? selectedServer.url : newUrl

    setNewName(nameToUse)
    setNewUrl(urlToUse)

    // Call registration inline with the resolved values to avoid stale state
    setStatus('registering')
    setError(null)
    const resolvedTargetUrl = urlToUse.trim() || url
    track('mcp_added', { url: resolvedTargetUrl, authType: authHint || (bearerToken ? 'bearer' : 'none'), location: 'session' })

    const popup = prepareOAuthPopup()

    if (authHint === 'oauth') {
      await startOAuthFlow(popup)
      return
    }

    try {
      const response = await apiFetch('/api/remote-mcps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: nameToUse.trim() || url,
          url: resolvedTargetUrl,
          authType: bearerToken ? 'bearer' : 'none',
          accessToken: bearerToken || undefined,
        }),
      })

      const responseData = await response.json()

      if (!response.ok) {
        if (responseData.needsOAuth) {
          await startOAuthFlow(popup)
          return
        }
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
      const { server } = responseData
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setSelectedMcpIds(new Set([server.id]))
      await apiFetch(`/api/remote-mcps/${server.id}/discover-tools`, { method: 'POST' })
      await refetch()
      setStatus('pending')
    } catch (err: unknown) {
      popup.close()
      setError(err instanceof Error ? err.message : 'Failed to register MCP server')
      setStatus('pending')
    }
  }


  const handleProvide = async () => {
    const providedMcpIds = selectedMcpIdsForProvide
    if (providedMcpIds.length === 0) return

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
            remoteMcpIds: providedMcpIds,
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to provide MCP access')
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to decline request')
      setStatus('pending')
    }
  }

  const handleStartRename = (server: RemoteMcpServer) => {
    setEditingMcpId(server.id)
    setEditMcpName(server.name)
  }

  const handleCancelRename = () => {
    setEditingMcpId(null)
    setEditMcpName('')
  }

  const handleSaveRename = async () => {
    const mcpId = editingMcpId
    const nextName = editMcpName.trim()
    if (!mcpId || !nextName) return

    setIsSavingRename(true)
    setError(null)

    try {
      const response = await apiFetch(`/api/remote-mcps/${mcpId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nextName }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to rename MCP')
      }

      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setEditingMcpId(null)
      setEditMcpName('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to rename MCP')
    } finally {
      setIsSavingRename(false)
    }
  }

  const openPolicyEditor = (server: RemoteMcpServer) => {
    const tools = (server.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }))
    setPolicyEditorMcp({ id: server.id, name: server.name, tools })
  }

  const mcpServerCardProps = (server: RemoteMcpServer) => ({
    server,
    isEditing: editingMcpId === server.id,
    editName: editMcpName,
    onEditNameChange: setEditMcpName,
    onSaveEdit: handleSaveRename,
    onCancelEdit: handleCancelRename,
    isSavingRename,
    menuOpen: menuOpenMcpId === server.id,
    onMenuOpenChange: (open: boolean) => setMenuOpenMcpId(open ? server.id : null),
    onStartRename: () => handleStartRename(server),
    onOpenPolicies: () => openPolicyEditor(server),
  })

  // Build completed config
  const isCompleted = status === 'provided' || status === 'declined'
  const completedConfig = isCompleted
    ? {
        icon: (
          <ServiceIcon
            slug={mcpSlug}
            fallback="mcp"
            className={cn(
              'h-4 w-4 shrink-0',
              status === 'provided' ? 'text-green-500' : 'text-red-500'
            )}
          />
        ),
        label: <span className="font-medium">MCP Server: {name || url}</span>,
        statusLabel: status === 'provided' ? 'Access Granted' : 'Declined',
        isSuccess: status === 'provided',
      }
    : null

  // Build read-only config
  const readOnlyConfig = readOnly
    ? {
        description: reason ? (
          <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
        ) : undefined,
      }
    : false as const

  return (
    <RequestItemShell
      title="MCP Access Request"
      icon={<Plug className="h-4 w-4" />}
      theme="blue"
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for response"
      error={error}
      data-testid={isCompleted ? 'remote-mcp-request-completed' : 'remote-mcp-request'}
      data-status={isCompleted ? status : undefined}
    >
      {reason && (
        <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        The MCP server will be connected to this agent.
      </p>

      <div className="mt-5">
        {status === 'oauth_pending' ? (
          <div className="flex items-center gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <div>
              <p className="text-sm font-normal text-foreground">
                Waiting for authorization...
              </p>
              <p className="text-xs text-muted-foreground">
                Complete the OAuth flow in your browser to connect this MCP server.
              </p>
            </div>
          </div>
        ) : isLoading ? (
          <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading MCP servers...</span>
          </div>
        ) : displayedServiceServers.length > 1 ? (
          <div className="space-y-2">
            <div className="space-y-2">
              <div className="space-y-1">
                {displayedServiceServers.map((server) => (
                  <McpServerCard
                    key={server.id}
                    {...mcpServerCardProps(server)}
                    selected={selectedMcpIds.has(server.id)}
                    onToggle={() =>
                      setSelectedMcpIds((prev) => {
                        const next = new Set(prev)
                        if (next.has(server.id)) {
                          next.delete(server.id)
                        } else {
                          next.add(server.id)
                        }
                        return next
                      })
                    }
                    disabled={status !== 'pending'}
                  />
                ))}
              </div>
            </div>
            <div className="!mt-1 ml-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleConnectAnother}
                loading={status === 'registering'}
                disabled={status !== 'pending'}
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="mr-1 h-4 w-4" />
                Add New Account
              </Button>
            </div>
          </div>
        ) : selectedServer ? (
          <div className="space-y-2">
            <McpServerCard
              {...mcpServerCardProps(selectedServer)}
            />
            <div className="!mt-1 ml-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleConnectAnother}
                loading={status === 'registering'}
                disabled={status !== 'pending'}
                className="text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Plus className="mr-1 h-4 w-4" />
                Add New Account
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                <McpSourceIcon slug={connectCardSlug} />
              </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-normal text-foreground">
                {newName.trim() || name || 'MCP Server'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {targetUrl}
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleRegisterNew}
              loading={status === 'registering'}
              disabled={status !== 'pending'}
              className="shrink-0 bg-foreground text-background hover:bg-foreground/90"
            >
              <Plus className="h-3.5 w-3.5" />
              Connect
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
        )}
      </div>

      {/* Action buttons */}
      {!selectedServer && !matchingServer && status !== 'oauth_pending' ? (
        <div className="mt-6 space-y-2">
          <RequestItemActions>
            <DeclineButton
              onDecline={handleDecline}
              disabled={status !== 'pending' && status !== 'registering'}
              label="Deny"
              showIcon={false}
              className="border-border text-foreground hover:bg-muted"
            />
          </RequestItemActions>
        </div>
      ) : null}

      {selectedServer ? (
        <div className="mt-6">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 self-end">
              {status !== 'oauth_pending' ? (
                <McpServicePicker
                  open={isMcpPickerOpen}
                  onOpenChange={setIsMcpPickerOpen}
                  options={pickerServiceOptions}
                  selectedServiceKey={selectedServiceKey}
                  onSelect={(_serviceKey, serverId) => {
                    setSelectedMcpIds(new Set([serverId]))
                  }}
                  disabled={status !== 'pending'}
                />
              ) : null}
            </div>
            <RequestItemActions>
              <DeclineButton
                onDecline={handleDecline}
                disabled={status !== 'pending' && status !== 'oauth_pending'}
                label="Deny"
                showIcon={false}
                className="border-border text-foreground hover:bg-muted"
              />

              <Button
                onClick={handleProvide}
                loading={status === 'submitting'}
                disabled={selectedMcpIdsForProvide.length === 0 || status !== 'pending'}
                size="sm"
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                Allow Access{selectedMcpIdsForProvide.length > 1 ? ` (${selectedMcpIdsForProvide.length})` : ''}
              </Button>
            </RequestItemActions>
          </div>
        </div>
      ) : null}

      {policyEditorMcp && (
        <ToolPolicyEditor
          mcpId={policyEditorMcp.id}
          mcpName={policyEditorMcp.name}
          tools={policyEditorMcp.tools}
          open={!!policyEditorMcp}
          onOpenChange={(open) => {
            if (!open) setPolicyEditorMcp(null)
          }}
        />
      )}
    </RequestItemShell>
  )
}
