import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Blocks,
  Check,
  ChevronDown,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Plug,
  X,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { ToolPolicySummaryPill } from '@renderer/components/ui/tool-policy-summary-pill'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'
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

function getMcpServiceKey(serverUrl: string) {
  const commonServer = COMMON_MCP_SERVERS.find((server) => server.url === serverUrl)
  if (commonServer?.slug) return commonServer.slug

  try {
    return new URL(serverUrl).hostname
  } catch {
    return serverUrl
  }
}

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

  const servers = useMemo(() => {
    if (debugServers) return debugServers
    const fetchedServers = Array.isArray(data?.servers) ? data.servers : []
    return debugHideExistingServers ? [] : fetchedServers
  }, [data, debugHideExistingServers, debugServers])
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
  const selectedServiceDisplayName = useMemo(() => {
    const commonServer = COMMON_MCP_SERVERS.find((server) => server.slug === selectedServiceKey)
    if (commonServer?.displayName) return commonServer.displayName
    if (selectedServer?.name) return selectedServer.name
    return newName.trim() || name || 'MCP server'
  }, [name, newName, selectedServer, selectedServiceKey])
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

  useEffect(() => {
    if (debugInitialStatus) {
      setStatus(debugInitialStatus)
    }
  }, [debugInitialStatus])

  useEffect(() => {
    if (debugSelectedMcpId) {
      setSelectedMcpIds(new Set([debugSelectedMcpId]))
    }
  }, [debugSelectedMcpId])

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
    if (selectedServer) {
      setNewName(selectedServer.name)
      setNewUrl(selectedServer.url)
    }
    await handleRegisterNew()
  }

  const handleOpenRemoteMcpSettings = () => {
    setIsMcpPickerOpen(false)
    window.dispatchEvent(
      new CustomEvent('open-global-settings', {
        detail: {
          initialTab: 'remote-mcps',
        },
      })
    )
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
    } catch (err: any) {
      setError(err.message || 'Failed to rename MCP')
    } finally {
      setIsSavingRename(false)
    }
  }

  const renderRenameMenu = (server: RemoteMcpServer, align: 'start' | 'end' = 'end') => (
    <Popover
      open={menuOpenMcpId === server.id}
      onOpenChange={(open) => setMenuOpenMcpId(open ? server.id : null)}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 w-5 shrink-0 p-0 text-muted-foreground/70 hover:bg-transparent hover:text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation()
          }}
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-32 p-1"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          size="sm"
          variant="ghost"
          className="w-full justify-start gap-2 text-foreground hover:bg-muted"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenuOpenMcpId(null)
            handleStartRename(server)
          }}
        >
          <Pencil className="h-3.5 w-3.5" />
          Rename
        </Button>
      </PopoverContent>
    </Popover>
  )

  const openPolicyEditor = (server: RemoteMcpServer) => {
    const tools = (server.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description,
    }))
    setPolicyEditorMcp({ id: server.id, name: server.name, tools })
  }

  const renderSelectedServerCard = (server: RemoteMcpServer) => {
    const selectedServerSlug = COMMON_MCP_SERVERS.find((commonServer) => commonServer.url === server.url)?.slug || ''
    const isEditing = editingMcpId === server.id

    if (isEditing) {
      return (
        <div className="rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
              <McpSourceIcon slug={selectedServerSlug} />
            </div>
            <Input
              value={editMcpName}
              onChange={(e) => setEditMcpName(e.target.value)}
              className="h-7 max-w-[296px] flex-1 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveRename()
                if (e.key === 'Escape') handleCancelRename()
              }}
            />
            <Button
              size="sm"
              variant="default"
              className="h-6 shrink-0 bg-foreground px-2 text-xs text-background hover:bg-foreground/90"
              onClick={handleSaveRename}
              disabled={isSavingRename}
            >
              {isSavingRename ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Check className="h-3 w-3" />
                  <span>Update</span>
                </>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-xs"
              onClick={handleCancelRename}
            >
              <X className="h-3 w-3" />
              <span>Cancel</span>
            </Button>
          </div>
        </div>
      )
    }

    return (
      <div className="group rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
        <div className="flex items-center gap-2">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
            <McpSourceIcon slug={selectedServerSlug} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <p className="truncate text-sm font-normal text-foreground">
                {server.name}
              </p>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {server.url}
            </p>
          </div>
          <div className="ml-3 flex shrink-0 items-center gap-2">
            <span onClick={(e) => e.stopPropagation()}>
              <ToolPolicySummaryPill
                mcpId={server.id}
                onClick={() => openPolicyEditor(server)}
              />
            </span>
            {renderRenameMenu(server)}
          </div>
        </div>
      </div>
    )
  }

  const renderServiceServerList = (serviceServers: RemoteMcpServer[]) => (
    <div className="space-y-2">
      <div className="space-y-1">
        {serviceServers.map((server) => {
          const serverSlug = COMMON_MCP_SERVERS.find((commonServer) => commonServer.url === server.url)?.slug || ''
          const isSelected = selectedMcpIds.has(server.id)
          const isEditing = editingMcpId === server.id

          if (isEditing) {
            return (
              <div
                key={server.id}
                className="flex items-center gap-2 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                  <McpSourceIcon slug={serverSlug} />
                </div>
                <Input
                  value={editMcpName}
                  onChange={(e) => setEditMcpName(e.target.value)}
                  className="h-7 max-w-[296px] flex-1 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveRename()
                    if (e.key === 'Escape') handleCancelRename()
                  }}
                />
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 shrink-0 bg-foreground px-2 text-xs text-background hover:bg-foreground/90"
                  onClick={handleSaveRename}
                  disabled={isSavingRename}
                >
                  {isSavingRename ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <Check className="h-3 w-3" />
                      <span>Update</span>
                    </>
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 shrink-0 px-2 text-xs"
                  onClick={handleCancelRename}
                >
                  <X className="h-3 w-3" />
                  <span>Cancel</span>
                </Button>
              </div>
            )
          }

          return (
            <button
              key={server.id}
              type="button"
              onClick={() =>
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
              className={cn(
                'group flex w-full items-center gap-3 rounded-[12px] border px-4 py-3 text-left transition-colors',
                isSelected
                  ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-950/40'
                  : 'border-border bg-white hover:bg-muted/40 dark:bg-background',
                status !== 'pending' && 'cursor-not-allowed opacity-70'
              )}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-background">
                <McpSourceIcon slug={serverSlug} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <p className="truncate text-sm font-normal text-foreground">
                    {server.name}
                  </p>
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {server.url}
                </p>
              </div>
              <div className="ml-3 flex shrink-0 items-center gap-2">
                <span onClick={(e) => e.stopPropagation()}>
                  <ToolPolicySummaryPill
                    mcpId={server.id}
                    onClick={() => openPolicyEditor(server)}
                  />
                </span>
                {renderRenameMenu(server)}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderMcpPicker = () => {
    if (servers.length === 0) return null

    return (
      <Popover open={isMcpPickerOpen} onOpenChange={setIsMcpPickerOpen}>
        <div className="inline-flex items-center gap-1 self-start px-1 py-1 text-xs text-muted-foreground">
          <span>Not the right MCP?</span>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={status !== 'pending'}
              className="inline-flex items-center gap-1 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span>Select a different one</span>
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
        </div>
        <PopoverContent align="start" side="top" className="w-[320px] max-w-[min(320px,calc(100vw-2rem))] p-1">
          <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
            {pickerServiceOptions.map((option) => {
              const isSelectedService = option.serviceKey === selectedServiceKey

              return (
                <button
                  key={option.serviceKey}
                  type="button"
                  onClick={() => {
                    setSelectedMcpIds(new Set([option.servers[0].id]))
                    setIsMcpPickerOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left transition-colors',
                    isSelectedService
                      ? 'bg-muted text-foreground'
                      : 'text-foreground hover:bg-muted/60'
                  )}
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                      <McpSourceIcon slug={option.slug} />
                    </div>
                    <span className="truncate text-sm">{option.displayName}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {option.servers.length} {option.servers.length === 1 ? 'account' : 'accounts'}
                    </span>
                  </div>
                  <div className="ml-3 flex shrink-0 items-center gap-2">
                    {isSelectedService ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-blue-600" />
                    ) : null}
                  </div>
                </button>
              )
            })}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            <button
              type="button"
              onClick={handleOpenRemoteMcpSettings}
              className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-foreground transition-colors hover:bg-muted/60"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="truncate text-sm">Add Custom MCP</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
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
              className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
              icon={<Plug className="h-4 w-4" />}
            >
              MCP Access Request
            </RequestTitleChip>
            {reason && (
              <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
            )}
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Waiting for response</span>
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
              className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
              icon={<Plug className="h-4 w-4" />}
            >
              MCP Access Request
            </RequestTitleChip>
            {reason && (
              <p className="mt-6 whitespace-pre-line text-sm font-medium leading-5 text-foreground">{reason}</p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              The MCP server will be connected to this agent.
            </p>
          </div>

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
                {renderServiceServerList(displayedServiceServers)}
                <div className="!mt-1 ml-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleConnectAnother}
                    disabled={status !== 'pending'}
                    className="text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {status === 'registering' ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-4 w-4" />
                    )}
                    Add New Account
                  </Button>
                </div>
              </div>
            ) : selectedServer ? (
              <div className="space-y-2">
                {renderSelectedServerCard(selectedServer)}
                <div className="!mt-1 ml-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleConnectAnother}
                    disabled={status !== 'pending'}
                    className="text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    {status === 'registering' ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="mr-1 h-4 w-4" />
                    )}
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
                <span className="shrink-0 rounded bg-muted/80 px-1.5 py-0.5 text-xs font-medium text-foreground/80">
                  not connected
                </span>
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
              <div className="flex justify-end gap-2">
                <DeclineButton
                  onDecline={handleDecline}
                  disabled={status !== 'pending' && status !== 'registering'}
                  label="Deny"
                  showIcon={false}
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
            </div>
          ) : null}

          {selectedServer ? (
            <div className="mt-6">
              <div className="flex items-end justify-between gap-3">
                <div className="min-w-0 self-end">
                  {status !== 'oauth_pending' ? renderMcpPicker() : null}
                </div>
                <div className="flex justify-end gap-2">
                  <DeclineButton
                    onDecline={handleDecline}
                    disabled={status !== 'pending' && status !== 'oauth_pending'}
                    label="Deny"
                    showIcon={false}
                    className="border-border text-foreground hover:bg-muted"
                  />

                  <Button
                    onClick={handleProvide}
                    disabled={selectedMcpIdsForProvide.length === 0 || status !== 'pending'}
                    size="sm"
                    className="bg-blue-600 hover:bg-blue-700 text-white"
                  >
                    {status === 'submitting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {status === 'submitting' ? (
                      <span className="ml-1">
                        Allow Access{selectedMcpIdsForProvide.length > 1 ? ` (${selectedMcpIdsForProvide.length})` : ''}
                      </span>
                    ) : (
                      `Allow Access${selectedMcpIdsForProvide.length > 1 ? ` (${selectedMcpIdsForProvide.length})` : ''}`
                    )}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {error && (
            <div className="mt-4 rounded-md bg-red-50 px-3 py-2 text-[11px] text-red-700 dark:bg-red-950/30 dark:text-red-300">
              Error: {error}
            </div>
          )}
        </div>
      </div>
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
    </div>
  )
}
