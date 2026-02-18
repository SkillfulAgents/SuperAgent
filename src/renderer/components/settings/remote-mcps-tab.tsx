import { useState, useEffect } from 'react'
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
import { Plus, Trash2, Loader2, RefreshCw, Plug, Wrench, AlertCircle, CheckCircle } from 'lucide-react'

export function RemoteMcpsTab() {
  const { data, isLoading } = useRemoteMcps()
  const addMcp = useAddRemoteMcp()
  const deleteMcp = useDeleteRemoteMcp()
  const discoverTools = useDiscoverMcpTools()
  const testConnection = useTestMcpConnection()
  const initiateOAuth = useInitiateMcpOAuth()

  const invalidateRemoteMcps = useInvalidateRemoteMcps()

  // Listen for MCP OAuth callback from main process
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
  const [oAuthPending, setOAuthPending] = useState<string | null>(null) // name of server being added via OAuth
  const [oAuthError, setOAuthError] = useState<string | null>(null)

  const servers = Array.isArray(data?.servers) ? data.servers : []

  const resetForm = () => {
    setNewName('')
    setNewUrl('')
    setNewAuthType('none')
    setNewToken('')
    setIsAdding(false)
  }

  const openAuthUrl = async (redirectUrl: string) => {
    if (window.electronAPI) {
      await window.electronAPI.openExternal(redirectUrl)
    } else {
      window.open(redirectUrl, '_blank')
    }
  }

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return
    const trimmedUrl = newUrl.trim()
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      return
    }

    if (newAuthType === 'oauth') {
      // OAuth-first: initiate OAuth immediately, server created after token exchange
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
          await openAuthUrl(result.redirectUrl)
        }
        resetForm()
      } catch {
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
    await deleteMcp.mutateAsync(id)
  }

  const handleDiscoverTools = async (id: string) => {
    await discoverTools.mutateAsync(id)
  }

  const handleTestConnection = async (id: string) => {
    await testConnection.mutateAsync(id)
  }

  const handleInitiateOAuth = async (id: string) => {
    try {
      const isElectronApp = !!window.electronAPI
      const result = await initiateOAuth.mutateAsync({ mcpId: id, electron: isElectronApp })
      if (result.redirectUrl) {
        if (window.electronAPI) {
          await window.electronAPI.openExternal(result.redirectUrl)
        } else {
          window.open(result.redirectUrl, '_blank')
        }
      }
    } catch {
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

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-medium">Remote MCP Servers</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Manage remote MCP servers that agents can connect to for additional tools and capabilities.
        </p>
      </div>

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
                  <Plug className="h-4 w-4 text-primary" />
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
                  disabled={testConnection.isPending}
                  title="Test connection"
                >
                  {testConnection.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDiscoverTools(server.id)}
                  disabled={discoverTools.isPending}
                  title="Discover tools"
                >
                  {discoverTools.isPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Wrench className="h-3 w-3" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(server.id)}
                  disabled={deleteMcp.isPending}
                >
                  {deleteMcp.isPending ? (
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
          No MCP servers registered yet.
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
      {!isAdding ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setIsAdding(true)}
        >
          <Plus className="h-4 w-4 mr-2" />
          Add MCP Server
        </Button>
      ) : (
        <div className="space-y-4 p-4 border rounded-md">
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
    </div>
  )
}
