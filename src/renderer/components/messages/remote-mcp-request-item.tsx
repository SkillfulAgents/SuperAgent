import { apiFetch } from '@renderer/lib/api'
import { warnIfLiveRefreshFailed } from '@renderer/lib/connection-live-refresh'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import {
  Loader2,
  Plus,
} from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { sameMcpEndpoint } from '@shared/lib/mcp/endpoint'
import { COMMON_MCP_SERVERS } from '@shared/lib/mcp/common-servers'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { ToolPolicyEditor } from '@renderer/components/settings/tool-policy-editor'
import { DeclineButton } from './decline-button'
import { RequestError } from './request-error'
import { RequestItemShell } from './request-item-shell'
import { RequestItemActions } from './request-item-actions'
import { cn } from '@shared/lib/utils/cn'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useInitiateMcpOAuth, useMcpOAuthRedirectUris } from '@renderer/hooks/use-remote-mcps'
import { McpSetupGuide } from '@renderer/components/connections/mcp-setup-guide'
import { McpAdvancedClientFields } from '@renderer/components/connections/mcp-advanced-client-fields'
import { useMcpLoginWindow } from '@renderer/hooks/use-mcp-login-window'
import { type LoginWindowOutcome } from '@renderer/hooks/use-login-window'
import { LoginButton, useFocusAfterCancel } from '@renderer/components/connections/login-button'
import { LoginWindowCancel } from '@renderer/components/connections/login-window-cancel'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { type RemoteMcpServer, getMcpServiceKey, McpSourceIcon, McpServerCard } from './mcp-server-card'
import { McpServicePicker } from './mcp-service-picker'

interface RemoteMcpRequestItemProps {
  toolUseId: string
  url: string
  name?: string
  reason?: string
  authHint?: 'oauth' | 'bearer'
  /** Prefill for the Advanced section, supplied by the agent. */
  clientId?: string
  clientName?: string
  agentSlug: string
  readOnly?: boolean
  onComplete: () => void
}

type RemoteMcpRequestProps = RemoteMcpRequestItemProps & (
  | { sessionId: string; replacement?: never }
  | { sessionId?: string; replacement: { requestId: string; onCancel: () => void } }
)

type RequestStatus = 'pending' | 'submitting' | 'provided' | 'declined'

export function RemoteMcpRequestItem({
  toolUseId,
  url,
  name,
  reason,
  authHint,
  clientId,
  clientName,
  sessionId,
  agentSlug,
  readOnly,
  onComplete,
  replacement,
}: RemoteMcpRequestProps) {
  const queryClient = useQueryClient()
  const initiateOAuth = useInitiateMcpOAuth()
  const { track } = useAnalyticsTracking()
  const mcpSlug = COMMON_MCP_SERVERS.find((cs) => cs.url === url)?.slug || ''
  const { data: redirectUris } = useMcpOAuthRedirectUris()
  const [status, setStatus] = useState<RequestStatus>('pending')
  const [error, setError] = useState<string | null>(null)
  const [selectedMcpIds, setSelectedMcpIds] = useState<Set<string>>(new Set())
  const [newName, setNewName] = useState(name || '')
  const [newUrl, setNewUrl] = useState(url)
  const [showTokenInput, setShowTokenInput] = useState(authHint === 'bearer')
  // Advanced OAuth client overrides. Seeded from what the agent passed, then
  // owned by the user — an agent that fetched an app ID from a provider console
  // should not have to be right for the user to correct it.
  const [advClientId, setAdvClientId] = useState(clientId || '')
  const [advClientName, setAdvClientName] = useState(clientName || '')
  const [advClientSecret, setAdvClientSecret] = useState('')
  const [bearerToken, setBearerToken] = useState('')
  // Bearer-server re-auth: which stale server is getting a replacement token
  const [reauthMcpId, setReauthMcpId] = useState<string | null>(null)
  const [reauthToken, setReauthToken] = useState('')
  const [isMcpPickerOpen, setIsMcpPickerOpen] = useState(false)
  const [editingMcpId, setEditingMcpId] = useState<string | null>(null)
  const [editMcpName, setEditMcpName] = useState('')
  const [isSavingRename, setIsSavingRename] = useState(false)
  const [menuOpenMcpId, setMenuOpenMcpId] = useState<string | null>(null)
  const [policyEditorMcp, setPolicyEditorMcp] = useState<{ id: string; name: string; tools: Array<{ name: string; description?: string }> } | null>(null)
  const targetUrl = newUrl.trim() || url
  const isReplacing = !!replacement
  const needsReplacementUrl = isReplacing && !url
  const validTargetUrl = useMemo(() => {
    try {
      const parsed = new URL(targetUrl)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
    } catch {
      return false
    }
  }, [targetUrl])

  // Fetch existing remote MCP servers
  const { data, isLoading, refetch } = useQuery<{ servers: RemoteMcpServer[] }>({
    queryKey: ['remote-mcps'],
    queryFn: async () => {
      const res = await apiFetch('/api/remote-mcps')
      if (!res.ok) throw new Error('Failed to fetch remote MCPs')
      return res.json()
    },
  })

  // Replacement must keep the original endpoint. Filter every selection path,
  // including the picker and submitted IDs, using the API's compatibility rule.
  const servers = useMemo(() => {
    const ownedServers = Array.isArray(data?.servers) ? data.servers : []
    return isReplacing
      ? ownedServers.filter((server) => sameMcpEndpoint(server.url, url || targetUrl))
      : ownedServers
  }, [data, isReplacing, url, targetUrl])
  const matchingServer = useMemo(
    () => servers.find((server) => server.url === targetUrl) || null,
    [servers, targetUrl]
  )
  const targetServiceKey = useMemo(() => getMcpServiceKey(targetUrl), [targetUrl])
  const targetServiceServers = useMemo(
    () => isReplacing ? servers : servers.filter((server) => getMcpServiceKey(server.url) === targetServiceKey),
    [servers, targetServiceKey, isReplacing]
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
    () => isReplacing ? servers : servers.filter((server) => getMcpServiceKey(server.url) === selectedServiceKey),
    [selectedServiceKey, servers, isReplacing]
  )
  const connectCardSlug = COMMON_MCP_SERVERS.find((server) => server.url === targetUrl)?.slug || mcpSlug
  // Provider-side setup the user has to do before this server can connect at all.
  const setupGuide = COMMON_MCP_SERVERS.find((server) => server.url === targetUrl)?.setup
  // Only active servers can be provided — a non-active server (e.g. expired
  // OAuth) would be dropped from the container env and the grant becomes a
  // silent no-op. Those servers get a Reconnect affordance instead.
  const activeServerIds = useMemo(
    () => new Set(servers.filter((server) => server.status === 'active').map((server) => server.id)),
    [servers]
  )
  const selectedMcpIdsForProvide = useMemo(() => {
    if (selectedMcpIds.size > 0) return Array.from(selectedMcpIds).filter((id) => activeServerIds.has(id))
    if (displayedServiceServers.length <= 1 && activeMcpId && activeServerIds.has(activeMcpId)) return [activeMcpId]
    return []
  }, [activeMcpId, activeServerIds, displayedServiceServers.length, selectedMcpIds])
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

  // Auto-select matching server on first load only. Non-active servers are
  // never auto-selected — they need re-auth before they can be provided.
  const hasAutoSelected = useRef(false)
  useEffect(() => {
    if (hasAutoSelected.current) return
    const initialSelection =
      servers.find((server) => server.url === targetUrl && server.status === 'active') ||
      targetServiceServers.find((server) => server.status === 'active')
    if (initialSelection) {
      setSelectedMcpIds(new Set([initialSelection.id]))
      hasAutoSelected.current = true
    }
  }, [servers, targetServiceServers, targetUrl])

  // When re-authenticating an existing server, remember which one: several
  // servers can share the same URL (multiple accounts), so a URL match after
  // OAuth could select a sibling instead of the server that was reconnected.
  const [launchedMcpId, setLaunchedMcpId] = useState<string | null>(null)
  const oauthTargetUrlRef = useRef(targetUrl)
  const { open: openLoginWindow, close: closeLoginWindow, pending: loginPending, waiting: waitingForOAuth, canCancel: canCancelLogin } = useMcpLoginWindow(
    ({ success, error: oauthError, mcpId }) => handleOAuthComplete(success, oauthError, mcpId),
  )
  // Work that opens no window: the slow follow-up after a server registered
  // without sign-in (refetch, tool discovery), and the bearer / no-auth recoveries.
  const [registering, setRegistering] = useState(false)
  const launching = registering || loginPending
  // The new-server buttons are busy only for their own launch, not a row's.
  const launchingNewServer = launching && launchedMcpId === null
  const busy = status !== 'pending' || launching
  // The waiting block replaces the launch buttons, so its Cancel returns
  // focus to the launch area once they are back.
  const { targetRef: launchAreaRef, arm: focusLaunchAreaAfterCancel } = useFocusAfterCancel<HTMLDivElement>(launching)

  // Handle OAuth completion from Electron IPC, postMessage, BroadcastChannel, or storage fallback.
  const handleOAuthComplete = useCallback((success: boolean, errorMessage?: string, completedMcpId?: string) => {
    // Close first, and stay busy through the refetch: a retry started
    // meanwhile would otherwise be closed by this attempt's continuation.
    closeLoginWindow()
    if (success) {
      setError(null)
      setRegistering(true)
      // Refetch servers to find the reconnected or newly created one
      refetch().then(({ data: refreshedData }) => {
        const refreshedServers = Array.isArray(refreshedData?.servers) ? refreshedData.servers : []
        const reconnectedId = launchedMcpId ?? completedMcpId
        const completedServer = reconnectedId
          ? refreshedServers.find((s) => s.id === reconnectedId && s.status === 'active')
          : refreshedServers.find((s) => s.url === targetUrl && s.status === 'active')
        if (completedServer && sameMcpEndpoint(completedServer.url, oauthTargetUrlRef.current)) {
          setSelectedMcpIds((prev) => new Set(replacement ? [] : prev).add(completedServer.id))
        } else {
          setError('The connected MCP does not match the requested endpoint or is unavailable. Please try again.')
        }
      }).catch(() => {}).finally(() => setRegistering(false))
    } else {
      setError(errorMessage || 'OAuth authorization failed')
    }
  }, [refetch, targetUrl, replacement, launchedMcpId, closeLoginWindow])

  // Opens the login window in the click, then registers a new server or
  // re-authenticates an existing one ({ mcpId }). The request only returns a
  // sign-in URL, or nothing when none is needed; what it learned is applied
  // once the hook confirms this attempt is still the current one.
  const connect = async (target: { mcpId: string } | { name: string; url: string }) => {
    const mcpId = 'mcpId' in target ? target.mcpId : null
    const name = 'mcpId' in target ? '' : target.name
    const connectionUrl = 'mcpId' in target
      ? servers.find((server) => server.id === target.mcpId)?.url ?? targetUrl
      : target.url
    setError(null)
    setLaunchedMcpId(mcpId)
    oauthTargetUrlRef.current = connectionUrl
    const learned: { server?: RemoteMcpServer; needsAuth?: string } = {}
    const isElectron = !!window.electronAPI
    const initiate = async () => {
      const result = await initiateOAuth.mutateAsync(
        mcpId
          ? { mcpId, electron: isElectron }
          : {
              name: name.trim() || connectionUrl,
              url: connectionUrl,
              electron: isElectron,
              clientId: advClientId.trim() || undefined,
              clientSecret: advClientSecret.trim() || undefined,
              clientName: advClientName.trim() || undefined,
            }
      )
      if (!result.redirectUrl || !result.state) {
        throw new Error('OAuth initiation did not return a redirect URL and state')
      }
      return result
    }

    let outcome: LoginWindowOutcome
    try {
      outcome = await openLoginWindow(async () => {
        // If agent hinted OAuth, go straight to OAuth flow
        if (mcpId || authHint === 'oauth') return initiate()

        const response = await apiFetch('/api/remote-mcps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: name.trim() || url,
            url: connectionUrl,
            authType: bearerToken ? 'bearer' : 'none',
            accessToken: bearerToken || undefined,
          }),
        })
        const responseData = await response.json()
        if (response.ok) {
          learned.server = responseData.server
          return null
        }
        // Server requires OAuth — automatically initiate OAuth flow
        if (responseData.needsOAuth) return initiate()
        // Server requires auth but not OAuth — show bearer token input
        if (responseData.needsAuth) {
          learned.needsAuth = responseData.error || 'This MCP server requires authentication.'
          return null
        }
        throw new Error(responseData.error || 'Failed to register MCP server')
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register MCP server')
      return
    }
    if (outcome !== 'no-url') return
    if (learned.needsAuth) {
      setShowTokenInput(true)
      setError(learned.needsAuth)
      return
    }
    if (!learned.server) return

    // Success — server registered without auth
    setRegistering(true)
    try {
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setSelectedMcpIds(new Set([learned.server.id]))

      // Try to discover tools
      await apiFetch(`/api/remote-mcps/${learned.server.id}/discover-tools`, {
        method: 'POST',
      })
      await refetch()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to register MCP server')
    } finally {
      setRegistering(false)
    }
  }

  // Recovery for a non-active server depends on how it authenticates: OAuth
  // servers re-run the OAuth flow, bearer servers need a fresh token, and
  // unauthenticated servers just get re-probed (the outage may have passed).
  const handleReconnect = async (server: RemoteMcpServer) => {
    setError(null)
    if (server.authType === 'oauth') {
      await connect({ mcpId: server.id })
      return
    }
    if (server.authType === 'bearer') {
      setReauthMcpId(server.id)
      setReauthToken('')
      return
    }
    await rediscoverServer(server.id)
  }

  // Re-probe a server via discover-tools, which flips it back to active on
  // success, then select it so it can be provided.
  const rediscoverServer = async (mcpId: string) => {
    setLaunchedMcpId(mcpId)
    setRegistering(true)
    try {
      const response = await apiFetch(`/api/remote-mcps/${mcpId}/discover-tools`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.error || 'Server is still unreachable')
      }
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setSelectedMcpIds((prev) => new Set(replacement ? [] : prev).add(mcpId))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reconnect failed')
    } finally {
      setRegistering(false)
    }
  }

  const handleSubmitReauthToken = async () => {
    const mcpId = reauthMcpId
    const token = reauthToken.trim()
    if (!mcpId || !token) return

    setLaunchedMcpId(mcpId)
    setRegistering(true)
    setError(null)
    try {
      const patchResponse = await apiFetch(`/api/remote-mcps/${mcpId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken: token }),
      })
      if (!patchResponse.ok) {
        const data = await patchResponse.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to update token')
      }
      const discoverResponse = await apiFetch(`/api/remote-mcps/${mcpId}/discover-tools`, {
        method: 'POST',
      })
      if (!discoverResponse.ok) {
        const data = await discoverResponse.json().catch(() => ({}))
        throw new Error(data.error || 'The server rejected the token')
      }
      queryClient.invalidateQueries({ queryKey: ['remote-mcps'] })
      await refetch()
      setSelectedMcpIds((prev) => new Set(replacement ? [] : prev).add(mcpId))
      setReauthMcpId(null)
      setReauthToken('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update token')
    } finally {
      setRegistering(false)
    }
  }

  const handleRegisterNew = async () => {
    if (!validTargetUrl) return
    track('mcp_added', { url: targetUrl, authType: authHint || (bearerToken ? 'bearer' : 'none'), location: 'session' })
    await connect({ name: newName, url: targetUrl })
  }

  const handleConnectAnother = async () => {
    const nameToUse = selectedServer ? selectedServer.name : newName
    const urlToUse = selectedServer ? selectedServer.url : newUrl

    setNewName(nameToUse)
    setNewUrl(urlToUse)

    // Call registration inline with the resolved values to avoid stale state
    const resolvedTargetUrl = urlToUse.trim() || url
    track('mcp_added', { url: resolvedTargetUrl, authType: authHint || (bearerToken ? 'bearer' : 'none'), location: 'session' })
    await connect({ name: nameToUse, url: resolvedTargetUrl })
  }


  const handleProvide = async () => {
    const providedMcpIds = selectedMcpIdsForProvide
    if (providedMcpIds.length === 0) return

    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(
        replacement
          ? `/api/agents/${agentSlug}/reauth-request/${replacement.requestId}/replace-mcp`
          : `/api/agents/${agentSlug}/sessions/${sessionId}/provide-remote-mcp`,
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

      if (replacement) {
        warnIfLiveRefreshFailed(await response.json().catch(() => ({})))
        queryClient.invalidateQueries({ queryKey: ['mcp-agents'] })
        queryClient.invalidateQueries({ queryKey: ['pending-user-requests'] })
      }
      setStatus('provided')
      // Bare prefix: agentSlug here is the session's display-slug route form, but the
      // agent-home Connections card keys on the canonical id — a targeted key misses it.
      queryClient.invalidateQueries({ queryKey: ['agent-remote-mcps'] })
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
    reconnect: server.status !== 'active'
      ? {
          start: () => handleReconnect(server),
          pending: launching && launchedMcpId === server.id,
          canCancel: canCancelLogin && launchedMcpId === server.id,
          onCancel: closeLoginWindow,
        }
      : undefined,
  })

  const addNewAccount = (
    <div className="!mt-1 ml-2">
      <LoginButton
        type="button"
        variant="ghost"
        size="xs"
        onClick={handleConnectAnother}
        icon={<Plus />}
        label="Add New Account"
        pendingLabel="Connecting…"
        pending={launchingNewServer}
        canCancel={canCancelLogin && launchedMcpId === null}
        onCancel={closeLoginWindow}
        cancelSide="right"
        disabled={busy}
        className="text-muted-foreground hover:bg-muted hover:text-foreground"
      />
    </div>
  )

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

  // Build read-only config — primary text now lives in the title.
  const readOnlyConfig = readOnly ? {} : false as const

  return (
    <RequestItemShell
      title={reason || `Connect MCP server: ${name || url}`}
      subtitle={replacement
        ? 'Choose or connect an MCP you own. This replaces the connection for this agent. Active sessions will be interrupted and told to use the new connection.'
        : 'The MCP server will be connected to this agent.'}
      theme="blue"
      sessionId={sessionId}
      agentSlug={agentSlug}
      completed={completedConfig}
      readOnly={readOnlyConfig}
      waitingText="Waiting for response"
      error={error}
      data-testid={isCompleted ? 'remote-mcp-request-completed' : 'remote-mcp-request'}
      data-status={isCompleted ? status : undefined}
    >
      {needsReplacementUrl && (
        <Input
          type="url"
          aria-label="MCP server URL"
          placeholder="Enter your MCP server URL"
          value={newUrl}
          onChange={(event) => {
            setNewUrl(event.target.value)
            setSelectedMcpIds(new Set())
            hasAutoSelected.current = false
            setError(null)
          }}
          disabled={busy}
          className="mt-3"
        />
      )}
      <span role="status" className="sr-only">
        {waitingForOAuth && 'Waiting for authorization…'}
        {waitingForOAuth && canCancelLogin && ', Cancel available'}
      </span>
      <div ref={launchAreaRef} tabIndex={-1} className="mt-3 rounded-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
        {waitingForOAuth ? (
          <div className="flex items-center gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            <div className="flex-1">
              <p className="text-sm font-normal text-foreground">
                Waiting for authorization...
              </p>
              <p className="text-xs text-muted-foreground">
                Complete the OAuth flow in your browser to connect this MCP server.
              </p>
            </div>
            <LoginWindowCancel
              visible={canCancelLogin}
              onCancel={() => {
                focusLaunchAreaAfterCancel()
                closeLoginWindow()
              }}
            />
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
                          if (replacement) next.clear()
                          next.add(server.id)
                        }
                        return next
                      })
                    }
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
            {addNewAccount}
          </div>
        ) : selectedServer ? (
          <div className="space-y-2">
            <McpServerCard
              {...mcpServerCardProps(selectedServer)}
              disabled={busy}
            />
            {addNewAccount}
          </div>
        ) : (
          <div className="space-y-2">
            {setupGuide && (
              <McpSetupGuide guide={setupGuide} redirectUri={redirectUris?.preferred} />
            )}
            <div className="flex items-center gap-3 rounded-[12px] border border-border bg-white px-4 py-3 dark:bg-background">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-white dark:bg-zinc-200">
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
            <LoginButton
              size="xs"
              onClick={handleRegisterNew}
              icon={<Plus />}
              label="Connect"
              pendingLabel="Connecting…"
              pending={launchingNewServer}
              canCancel={canCancelLogin && launchedMcpId === null}
              onCancel={closeLoginWindow}
              cancelSide="left"
              disabled={!validTargetUrl || busy}
              className="shrink-0 bg-foreground text-background hover:bg-foreground/90"
            />
            </div>
            {showTokenInput && (
              <Input
                type="password"
                value={bearerToken}
                onChange={(e) => setBearerToken(e.target.value)}
                placeholder="Bearer token"
                className="h-8 text-sm"
                disabled={busy}
              />
            )}
            {authHint !== 'bearer' && (
              <McpAdvancedClientFields
                values={{
                  clientName: advClientName,
                  clientId: advClientId,
                  clientSecret: advClientSecret,
                }}
                onChange={(next) => {
                  setAdvClientName(next.clientName)
                  setAdvClientId(next.clientId)
                  setAdvClientSecret(next.clientSecret)
                }}
                defaultOpen={setupGuide?.requiresClientId || !!clientId}
                disabled={busy}
                variant="compact"
                testIdPrefix="mcp-request"
              />
            )}
          </div>
        )}
        {reauthMcpId && !waitingForOAuth ? (
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="password"
              value={reauthToken}
              onChange={(e) => setReauthToken(e.target.value)}
              placeholder="New bearer token"
              className="h-8 flex-1 text-sm"
              autoFocus
              disabled={busy}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmitReauthToken()
                if (e.key === 'Escape') {
                  setReauthMcpId(null)
                  setReauthToken('')
                }
              }}
            />
            <Button
              size="xs"
              onClick={handleSubmitReauthToken}
              loading={registering}
              disabled={!reauthToken.trim() || busy}
              className="shrink-0 bg-foreground text-background hover:bg-foreground/90"
            >
              Save Token
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setReauthMcpId(null)
                setReauthToken('')
              }}
              disabled={registering}
              className="shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              Cancel
            </Button>
          </div>
        ) : null}
      </div>

      {/* Action buttons */}
      {!selectedServer && !matchingServer && !waitingForOAuth ? (
        <RequestItemActions>
          {replacement ? (
            <Button size="xs" variant="outline" onClick={replacement.onCancel} disabled={status === 'submitting'}>
              Cancel
            </Button>
          ) : (
            <DeclineButton
              onDecline={handleDecline}
              disabled={busy}
              label="Deny"
              showIcon={false}
              className="border-border text-foreground hover:bg-muted"
            />
          )}
        </RequestItemActions>
      ) : null}

      {selectedServer ? (
        <>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0 self-end pt-4">
              {!waitingForOAuth ? (
                <McpServicePicker
                  open={isMcpPickerOpen}
                  onOpenChange={setIsMcpPickerOpen}
                  options={pickerServiceOptions}
                  selectedServiceKey={selectedServiceKey}
                  onSelect={(_serviceKey, serverId) => {
                    setSelectedMcpIds(new Set([serverId]))
                  }}
                  disabled={busy}
                />
              ) : null}
            </div>
            <RequestItemActions inline>
              {replacement ? (
                <Button size="xs" variant="outline" onClick={replacement.onCancel} disabled={status === 'submitting'}>
                  Cancel
                </Button>
              ) : (
                <DeclineButton
                  onDecline={handleDecline}
                  disabled={busy}
                  label="Deny"
                  showIcon={false}
                  className="border-border text-foreground hover:bg-muted"
                />
              )}

              <Button
                onClick={handleProvide}
                loading={status === 'submitting'}
                disabled={selectedMcpIdsForProvide.length === 0 || busy}
                size="xs"
                className="bg-blue-600 hover:bg-blue-700 text-white"
              >
                {replacement ? 'Replace connection' : `Allow Access${selectedMcpIdsForProvide.length > 1 ? ` (${selectedMcpIdsForProvide.length})` : ''}`}
              </Button>
            </RequestItemActions>
          </div>
          {error ? <RequestError message={error} /> : null}
        </>
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
