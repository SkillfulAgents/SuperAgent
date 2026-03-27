import { useState, useEffect, useMemo, useRef } from 'react'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import {
  useRemoteMcps,
  useAddRemoteMcp,
  useDeleteRemoteMcp,
  useDiscoverMcpTools,
  useTestMcpConnection,
  useInitiateMcpOAuth,
  useInvalidateRemoteMcps,
} from '@renderer/hooks/use-remote-mcps'
import { Plus, Trash2, Loader2, RefreshCw, Plug, Wrench, AlertCircle, CheckCircle, Search, Shield } from 'lucide-react'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { useAnalyticsTracking } from '@renderer/context/analytics-context'
import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'
import { useQuery } from '@tanstack/react-query'
import type { CommonMcpServer } from '@shared/lib/mcp/common-servers'
import { ToolPolicyEditor } from './tool-policy-editor'

export function RemoteMcpsTab() {
  const { data, isLoading } = useRemoteMcps()
  const addMcp = useAddRemoteMcp()
  const deleteMcp = useDeleteRemoteMcp()
  const discoverTools = useDiscoverMcpTools()
  const testConnection = useTestMcpConnection()
  const initiateOAuth = useInitiateMcpOAuth()
  const invalidateRemoteMcps = useInvalidateRemoteMcps()
  const { track } = useAnalyticsTracking()
  const [policyEditorMcp, setPolicyEditorMcp] = useState<{ id: string; name: string; tools: Array<{ name: string; description?: string }> } | null>(null)

  const { data: commonData } = useQuery<{ servers: CommonMcpServer[] }>({
    queryKey: ['common-mcp-servers'],
    queryFn: async () => {
      const res = await apiFetch('/api/common-mcp-servers')
      if (!res.ok) throw new Error('Failed to fetch common MCP servers')
      return res.json()
    },
  })

  // Listen for MCP OAuth callback from main process (Electron)
  useEffect(() => {
    if (!window.electronAPI) return

    window.electronAPI.onMcpOAuthCallback((params) => {
      setOAuthPending(null)
      if (params.success) {
        setOAuthError(null)
        invalidateRemoteMcps()
      } else {
        setOAuthError(params.error || 'OAuth failed')
      }
    })

    return () => {
      window.electronAPI?.removeMcpOAuthCallback()
    }
  }, [invalidateRemoteMcps])

  const [isAdding, setIsAdding] = useState(false)
  const [newName, setNewName] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newAuthType, setNewAuthType] = useState<'none' | 'oauth' | 'bearer'>('none')
  const [newToken, setNewToken] = useState('')
  const [oAuthPending, setOAuthPending] = useState<string | null>(null)
  const [oAuthError, setOAuthError] = useState<string | null>(null)

  // Listen for MCP OAuth callback via postMessage (web mode)
  useEffect(() => {
    if (!oAuthPending) return

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'mcp-oauth-callback') {
        setOAuthPending(null)
        if (event.data.success) {
          setOAuthError(null)
          invalidateRemoteMcps()
        } else {
          setOAuthError(event.data.error || 'OAuth failed')
        }
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [oAuthPending, invalidateRemoteMcps])

  const [searchQuery, setSearchQuery] = useState('')
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)
  const addFormRef = useRef<HTMLDivElement>(null)

  const servers = Array.isArray(data?.servers) ? data.servers : []
  const commonServers = useMemo(() => commonData?.servers || [], [commonData?.servers])

  const filteredCommon = useMemo(() => {
    if (!searchQuery.trim()) return commonServers
    const term = searchQuery.toLowerCase()
    return commonServers.filter(
      (s) =>
        s.displayName.toLowerCase().includes(term) ||
        s.slug.includes(term) ||
        s.category.toLowerCase().includes(term) ||
        s.description.toLowerCase().includes(term)
    )
  }, [commonServers, searchQuery])

  const groupedCommon = useMemo(() => {
    const groups: Record<string, CommonMcpServer[]> = {}
    for (const server of filteredCommon) {
      if (!groups[server.category]) groups[server.category] = []
      groups[server.category].push(server)
    }
    return groups
  }, [filteredCommon])

  const resetForm = () => {
    setNewName('')
    setNewUrl('')
    setNewAuthType('none')
    setNewToken('')
    setIsAdding(false)
  }

  const openAddForm = (server?: CommonMcpServer) => {
    if (server) {
      setNewName(server.displayName)
      setNewUrl(server.url)
      setNewAuthType(server.authType)
    } else {
      setNewName('')
      setNewUrl('')
      setNewAuthType('none')
    }
    setNewToken('')
    setIsAdding(true)
    // Scroll to form after React renders it
    setTimeout(() => {
      addFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 0)
  }

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return
    const trimmedUrl = newUrl.trim()
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      return
    }

    track('mcp_added', { url: trimmedUrl, authType: newAuthType, location: 'settings' })

    if (newAuthType === 'oauth') {
      const popup = prepareOAuthPopup()

      try {
        const serverName = newName.trim()
        const isElectronApp = !!window.electronAPI
        const result = await initiateOAuth.mutateAsync({
          name: serverName,
          url: newUrl.trim(),
          electron: isElectronApp,
        })
        if (result.redirectUrl) {
          setOAuthError(null)
          setOAuthPending(serverName)
          await popup.navigate(result.redirectUrl)
        } else {
          popup.close()
        }
        resetForm()
      } catch {
        popup.close()
        // Error is handled by mutation — form stays open for retry
      }
    } else {
      try {
        await addMcp.mutateAsync({
          name: newName.trim(),
          url: newUrl.trim(),
          authType: newAuthType,
          accessToken: newAuthType === 'bearer' ? newToken.trim() : undefined,
        })
        resetForm()
      } catch {
        // Error is handled by the mutation
      }
    }
  }

  const handleDelete = async (id: string) => {
    setPendingActionId(id)
    try { await deleteMcp.mutateAsync(id) } finally { setPendingActionId(null) }
  }

  const handleDiscoverTools = async (id: string) => {
    setPendingActionId(id)
    try { await discoverTools.mutateAsync(id) } finally { setPendingActionId(null) }
  }

  const handleTestConnection = async (id: string) => {
    setPendingActionId(id)
    try { await testConnection.mutateAsync(id) } finally { setPendingActionId(null) }
  }

  const handleInitiateOAuth = async (id: string) => {
    const popup = prepareOAuthPopup()

    try {
      const isElectronApp = !!window.electronAPI
      const result = await initiateOAuth.mutateAsync({ mcpId: id, electron: isElectronApp })
      if (result.redirectUrl) {
        await popup.navigate(result.redirectUrl)
      } else {
        popup.close()
      }
    } catch {
      popup.close()
      // Error is handled by mutation
    }
  }

  const statusIcon = (status: string) => {
    switch (status) {
      case 'active':
        return <CheckCircle className="h-4 w-4 text-green-500" />
      case 'auth_required':
        return <AlertCircle className="h-4 w-4 text-yellow-500" />
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />
      default:
        return null
    }
  }

  const authBadge = (authType: string) => {
    switch (authType) {
      case 'oauth':
        return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">OAuth</span>
      case 'bearer':
        return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">API Key</span>
      default:
        return <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">No auth</span>
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-medium">Remote MCP Servers</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Manage remote MCP servers that agents can connect to for additional tools and capabilities.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => openAddForm()}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Custom Server
        </Button>
      </div>

      {/* Registered servers */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading MCP servers...
        </div>
      ) : servers.length > 0 ? (
        <div className="space-y-2">
          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-start justify-between p-3 rounded-md border bg-muted/30"
            >
              <div className="flex items-start gap-3 flex-1 min-w-0">
                <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <ServiceIcon slug={commonServers.find((cs) => cs.url === server.url)?.slug || ''} fallback="mcp" className="h-4 w-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{server.name}</p>
                    {statusIcon(server.status)}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">{server.url}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-muted-foreground">
                      {server.authType === 'none' ? 'No auth' : server.authType}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {server.tools.length} tools
                    </span>
                    {server.errorMessage && (
                      <span className="text-xs text-red-500 truncate">
                        {server.errorMessage}
                      </span>
                    )}
                  </div>
                  {server.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {server.tools.slice(0, 5).map((tool) => (
                        <span
                          key={tool.name}
                          className="text-xs px-1.5 py-0.5 rounded bg-muted border"
                        >
                          {tool.name}
                        </span>
                      ))}
                      {server.tools.length > 5 && (
                        <span className="text-xs text-muted-foreground">
                          +{server.tools.length - 5} more
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0 ml-2">
                {server.status === 'auth_required' && server.authType === 'oauth' && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleInitiateOAuth(server.id)}
                    disabled={initiateOAuth.isPending}
                    title="Connect via OAuth"
                  >
                    {initiateOAuth.isPending ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Plug className="h-3 w-3" />
                    )}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleTestConnection(server.id)}
                  disabled={pendingActionId !== null}
                  title="Test connection"
                >
                  {pendingActionId === server.id && testConnection.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDiscoverTools(server.id)}
                  disabled={pendingActionId !== null}
                  title="Discover tools"
                >
                  {pendingActionId === server.id && discoverTools.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wrench className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const tools = (server.tools || []).map((t: any) => ({
                      name: t.name,
                      description: t.description,
                    }))
                    setPolicyEditorMcp({ id: server.id, name: server.name, tools })
                  }}
                  title="Manage tool policies"
                >
                  <Shield className="h-3 w-3" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(server.id)}
                  disabled={pendingActionId !== null}
                >
                  {pendingActionId === server.id && deleteMcp.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 text-destructive" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : !oAuthPending ? (
        <p className="text-sm text-muted-foreground">
          No MCP servers registered yet. Browse the directory below or add a custom server.
        </p>
      ) : null}

      {oAuthPending && (
        <div className="flex items-center gap-3 p-3 rounded-md border bg-muted/30">
          <Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
          <div>
            <p className="text-sm font-medium">{oAuthPending}</p>
            <p className="text-xs text-muted-foreground">Waiting for authorization and discovering tools...</p>
          </div>
        </div>
      )}

      {oAuthError && (
        <div className="flex items-center gap-2 p-3 rounded-md border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0" />
          <p className="text-sm text-red-600 dark:text-red-400">{oAuthError}</p>
        </div>
      )}

      {/* Add MCP server form */}
      {isAdding && (
        <div ref={addFormRef} className="space-y-4 p-4 border rounded-md">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium">Add MCP Server</Label>
            <Button
              size="sm"
              variant="ghost"
              onClick={resetForm}
            >
              Cancel
            </Button>
          </div>

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Name</Label>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="e.g., Granola Meetings"
                className="mt-1"
              />
            </div>

            <div>
              <Label className="text-xs">URL</Label>
              <Input
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="e.g., https://mcp.granola.ai/mcp"
                className="mt-1"
              />
            </div>

            <div>
              <Label className="text-xs">Authentication</Label>
              <Select
                value={newAuthType}
                onValueChange={(v) => setNewAuthType(v as 'none' | 'oauth' | 'bearer')}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Authentication</SelectItem>
                  <SelectItem value="oauth">OAuth</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newAuthType === 'bearer' && (
              <div>
                <Label className="text-xs">Access Token</Label>
                <Input
                  type="password"
                  value={newToken}
                  onChange={(e) => setNewToken(e.target.value)}
                  placeholder="Enter bearer token"
                  className="mt-1"
                />
              </div>
            )}
          </div>

          <Button
            size="sm"
            onClick={handleAdd}
            disabled={!newName.trim() || !newUrl.trim() || addMcp.isPending || initiateOAuth.isPending}
          >
            {(addMcp.isPending || initiateOAuth.isPending) ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {initiateOAuth.isPending ? 'Connecting...' : 'Adding...'}
              </>
            ) : (
              <>Add Server</>
            )}
          </Button>

          {(addMcp.error || initiateOAuth.error) && (
            <p className="text-sm text-red-500">{(addMcp.error || initiateOAuth.error)?.message}</p>
          )}
        </div>
      )}

      {/* Common MCP servers directory */}
      <div className="space-y-3">
        <div>
          <Label className="text-sm font-medium">Server Directory</Label>
          <p className="text-xs text-muted-foreground mt-0.5">
            Browse common MCP servers. Click to add one.
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search MCP servers..."
            className="pl-9"
          />
        </div>

        {Object.keys(groupedCommon).length === 0 ? (
          <p className="text-sm text-muted-foreground">No servers match your search.</p>
        ) : (
          <div className="space-y-4">
            {Object.entries(groupedCommon).map(([category, categoryServers]) => (
              <div key={category}>
                <p className="text-xs font-medium text-muted-foreground mb-2">{category}</p>
                <div className="grid grid-cols-2 gap-2">
                  {categoryServers.map((server) => (
                    <button
                      key={server.slug}
                      type="button"
                      className="flex items-start gap-2.5 p-2.5 rounded-md border bg-card text-left hover:bg-accent/50 transition-colors"
                      onClick={() => openAddForm(server)}
                    >
                      <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <ServiceIcon slug={server.slug} fallback="mcp" className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-medium truncate">{server.displayName}</p>
                          {authBadge(server.authType)}
                        </div>
                        <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{server.description}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tool policy editor modal */}
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
