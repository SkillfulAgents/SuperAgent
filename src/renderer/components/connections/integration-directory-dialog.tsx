import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Loader2, Search } from 'lucide-react'
import { IntegrationList, IntegrationRow } from './integration-row'
import {
  useInitiateConnection,
  useInvalidateConnectedAccounts,
} from '@renderer/hooks/use-connected-accounts'
import {
  useAddRemoteMcp,
  useInitiateMcpOAuth,
} from '@renderer/hooks/use-remote-mcps'
import type { Provider } from '@shared/lib/composio/providers'
import { COMMON_MCP_SERVERS, type CommonMcpServer } from '@shared/lib/mcp/common-servers'

export type DirectoryTab = 'apis' | 'mcps'

interface IntegrationDirectoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialTab?: DirectoryTab
}

export function IntegrationDirectoryDialog({ open, onOpenChange, initialTab = 'apis' }: IntegrationDirectoryDialogProps) {
  const [tab, setTab] = useState<DirectoryTab>(initialTab)

  useEffect(() => {
    if (open) setTab(initialTab)
  }, [open, initialTab])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add integration</DialogTitle>
          <DialogDescription>
            Browse APIs and MCP servers to connect to this workspace.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as DirectoryTab)} className="flex flex-col gap-4">
          <TabsList className="self-start">
            <TabsTrigger value="apis" data-testid="directory-tab-apis">APIs</TabsTrigger>
            <TabsTrigger value="mcps" data-testid="directory-tab-mcps">MCPs</TabsTrigger>
          </TabsList>
          <TabsContent value="apis" className="mt-0">
            <ApisPanel onConnected={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="mcps" className="mt-0">
            <McpsPanel onAdded={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// --- APIs panel ---

function ApisPanel({ onConnected }: { onConnected: () => void }) {
  const { data: providersData, isLoading } = useQuery<{ providers: Provider[] }>({
    queryKey: ['providers'],
    queryFn: async () => {
      const res = await apiFetch('/api/providers')
      if (!res.ok) throw new Error('Failed to fetch providers')
      return res.json()
    },
  })
  const initiateConnection = useInitiateConnection()
  const invalidateAccounts = useInvalidateConnectedAccounts()

  const [filter, setFilter] = useState('')
  const [connecting, setConnecting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const handleComplete = (success: boolean) => {
      setConnecting(null)
      if (success) {
        invalidateAccounts()
        onConnected()
      }
    }

    if (window.electronAPI) {
      window.electronAPI.onOAuthCallback(async (params) => {
        if (params.error || params.status === 'failed') {
          handleComplete(false)
          return
        }
        if (params.connectionId && params.toolkit) {
          try {
            const res = await apiFetch('/api/connected-accounts/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                connectionId: params.connectionId,
                toolkit: params.toolkit,
              }),
            })
            handleComplete(res.ok)
          } catch {
            handleComplete(false)
          }
        } else {
          handleComplete(false)
        }
      })
      return () => { window.electronAPI?.removeOAuthCallback() }
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'oauth-callback') {
        handleComplete(event.data.success)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [invalidateAccounts, onConnected])

  const filtered = useMemo(() => {
    const providers = providersData?.providers ?? []
    if (!filter.trim()) return providers
    const q = filter.toLowerCase()
    return providers.filter((p) =>
      p.displayName.toLowerCase().includes(q) ||
      p.slug.toLowerCase().includes(q) ||
      p.description.toLowerCase().includes(q)
    )
  }, [providersData, filter])

  const handleConnect = async (slug: string) => {
    setConnecting(slug)
    setError(null)
    const popup = prepareOAuthPopup()
    try {
      const isElectron = !!window.electronAPI
      const result = await initiateConnection.mutateAsync({ providerSlug: slug, electron: isElectron })
      await popup.navigate(result.redirectUrl)
    } catch (err) {
      popup.close()
      setError(err instanceof Error ? err.message : 'Failed to connect')
      setConnecting(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search APIs..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8"
        />
      </div>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading APIs...
        </div>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No APIs match your search.</p>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto pr-1">
          <IntegrationList>
            {filtered.map((provider) => {
              const pending = connecting === provider.slug
              return (
                <IntegrationRow
                  key={provider.slug}
                  iconSlug={provider.slug}
                  iconFallback="oauth"
                  name={<HighlightMatch text={provider.displayName} query={filter} />}
                  subtitle={provider.description}
                  right={
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleConnect(provider.slug)}
                      disabled={connecting !== null}
                      data-testid={`directory-connect-api-${provider.slug}`}
                    >
                      {pending ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                          Connecting
                        </>
                      ) : (
                        'Connect'
                      )}
                    </Button>
                  }
                />
              )
            })}
          </IntegrationList>
        </div>
      )}
    </div>
  )
}

// --- MCPs panel ---

function McpsPanel({ onAdded }: { onAdded: () => void }) {
  const addMcp = useAddRemoteMcp()
  const initiateOAuth = useInitiateMcpOAuth()

  const [filter, setFilter] = useState('')
  const [pendingSlug, setPendingSlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [bearerFor, setBearerFor] = useState<CommonMcpServer | null>(null)
  const [bearerToken, setBearerToken] = useState('')

  const filtered = useMemo(() => {
    if (!filter.trim()) return COMMON_MCP_SERVERS
    const q = filter.toLowerCase()
    return COMMON_MCP_SERVERS.filter((s) =>
      s.displayName.toLowerCase().includes(q) ||
      s.slug.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q)
    )
  }, [filter])

  const grouped = useMemo(() => {
    const map: Record<string, CommonMcpServer[]> = {}
    for (const s of filtered) {
      if (!map[s.category]) map[s.category] = []
      map[s.category].push(s)
    }
    return map
  }, [filtered])

  const handlePickServer = async (server: CommonMcpServer) => {
    setError(null)
    if (server.authType === 'bearer') {
      setBearerFor(server)
      setBearerToken('')
      return
    }
    setPendingSlug(server.slug)
    try {
      if (server.authType === 'oauth') {
        const popup = prepareOAuthPopup()
        try {
          const isElectron = !!window.electronAPI
          const result = await initiateOAuth.mutateAsync({
            name: server.displayName,
            url: server.url,
            electron: isElectron,
          })
          if (result.redirectUrl) {
            await popup.navigate(result.redirectUrl)
          } else {
            popup.close()
          }
          onAdded()
        } catch (err) {
          popup.close()
          throw err
        }
      } else {
        // none
        await addMcp.mutateAsync({
          name: server.displayName,
          url: server.url,
          authType: 'none',
        })
        onAdded()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add MCP server')
    } finally {
      setPendingSlug(null)
    }
  }

  const handleSubmitBearer = async () => {
    if (!bearerFor || !bearerToken.trim()) return
    setError(null)
    setPendingSlug(bearerFor.slug)
    try {
      await addMcp.mutateAsync({
        name: bearerFor.displayName,
        url: bearerFor.url,
        authType: 'bearer',
        accessToken: bearerToken.trim(),
      })
      setBearerFor(null)
      setBearerToken('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add MCP server')
    } finally {
      setPendingSlug(null)
    }
  }

  const authBadge = (t: CommonMcpServer['authType']) => {
    switch (t) {
      case 'oauth':
        return <span className="text-2xs px-1.5 py-0.5 rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">OAuth</span>
      case 'bearer':
        return <span className="text-2xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">API Key</span>
      default:
        return <span className="text-2xs px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">No auth</span>
    }
  }

  if (bearerFor) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-3 p-3 rounded-md border bg-muted/30">
          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <ServiceIcon slug={bearerFor.slug} fallback="mcp" className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{bearerFor.displayName}</p>
            <p className="text-xs text-muted-foreground truncate">{bearerFor.url}</p>
          </div>
        </div>
        <div>
          <label htmlFor="bearer-token" className="text-xs font-medium">
            API key
          </label>
          <Input
            id="bearer-token"
            type="password"
            value={bearerToken}
            onChange={(e) => setBearerToken(e.target.value)}
            placeholder="Paste your API key"
            className="mt-1"
            autoFocus
          />
        </div>
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setBearerFor(null); setBearerToken(''); setError(null) }}
            disabled={pendingSlug !== null}
          >
            Back
          </Button>
          <Button
            size="sm"
            onClick={handleSubmitBearer}
            disabled={!bearerToken.trim() || pendingSlug !== null}
          >
            {pendingSlug === bearerFor.slug ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Adding...
              </>
            ) : (
              'Add server'
            )}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search MCP servers..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="pl-8"
        />
      </div>
      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      {Object.keys(grouped).length === 0 ? (
        <p className="text-sm text-muted-foreground">No MCP servers match your search.</p>
      ) : (
        <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
          {Object.entries(grouped).map(([category, servers]) => (
            <div key={category} className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground px-1">
                {category}
              </p>
              <IntegrationList>
                {servers.map((server) => {
                  const isPending = pendingSlug === server.slug
                  return (
                    <IntegrationRow
                      key={server.slug}
                      iconSlug={server.slug}
                      iconFallback="mcp"
                      name={<HighlightMatch text={server.displayName} query={filter} />}
                      subtitle={<span className="truncate">{server.description}</span>}
                      right={
                        <>
                          {authBadge(server.authType)}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handlePickServer(server)}
                            disabled={pendingSlug !== null}
                            data-testid={`directory-connect-mcp-${server.slug}`}
                          >
                            {isPending ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                                Adding
                              </>
                            ) : (
                              'Connect'
                            )}
                          </Button>
                        </>
                      }
                    />
                  )
                })}
              </IntegrationList>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
