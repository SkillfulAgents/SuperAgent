import { apiFetch } from '@renderer/lib/api'
import { prepareOAuthPopup } from '@renderer/lib/oauth-popup'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@renderer/components/ui/tabs'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Label } from '@renderer/components/ui/label'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { cn } from '@shared/lib/utils/cn'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui/select'
import { HighlightMatch } from '@renderer/components/ui/highlight-match'
import { Loader2, Plus, Search } from 'lucide-react'
import { IntegrationList, IntegrationRow } from './integration-row'
import { mcpDraftSchema, type McpDraft, type McpAuthType } from './mcp-draft-schema'
import {
  useInitiateConnection,
  useInvalidateConnectedAccounts,
} from '@renderer/hooks/use-connected-accounts'
import {
  useAddRemoteMcp,
  useInitiateMcpOAuth,
  useInvalidateRemoteMcps,
} from '@renderer/hooks/use-remote-mcps'
import { useMcpOAuthListener } from '@renderer/hooks/use-mcp-oauth-listener'
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
  const [filter, setFilter] = useState('')
  const prevOpen = useRef(open)

  // Reset only when the dialog transitions from closed → open, not when the
  // `initialTab` prop identity churns mid-session.
  useEffect(() => {
    if (open && !prevOpen.current) {
      setTab(initialTab)
      setFilter('')
    }
    prevOpen.current = open
  }, [open, initialTab])

  const handleTabChange = (v: string) => {
    setTab(v as DirectoryTab)
    setFilter('')
  }

  const close = useCallback(() => onOpenChange(false), [onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="font-medium">Add New Connection</DialogTitle>
        </DialogHeader>
        <Tabs value={tab} onValueChange={handleTabChange} className="flex flex-col gap-4 mt-4 min-h-[50vh]">
          <div className="flex items-center gap-2">
            <TabsList>
              <TabsTrigger value="apis" data-testid="directory-tab-apis">APIs</TabsTrigger>
              <TabsTrigger value="mcps" data-testid="directory-tab-mcps">MCPs</TabsTrigger>
            </TabsList>
            <div className="relative ml-auto w-56">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={tab === 'apis' ? 'Search APIs...' : 'Search MCP servers...'}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-8"
              />
            </div>
          </div>
          <TabsContent value="apis" className="mt-0">
            <ApisPanel filter={filter} onConnected={close} />
          </TabsContent>
          <TabsContent value="mcps" className="mt-0">
            <McpsPanel filter={filter} onAdded={close} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

// --- APIs panel ---

function ApisPanel({ filter, onConnected }: { filter: string; onConnected: () => void }) {
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
    const providers = Array.isArray(providersData?.providers) ? providersData.providers : []
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
      const result = await initiateConnection.mutateAsync({
        providerSlug: slug,
        electron: isElectron,
        location: 'connections_tab',
      })
      await popup.navigate(result.redirectUrl)
    } catch (err) {
      popup.close()
      setError(err instanceof Error ? err.message : 'Failed to connect')
      setConnecting(null)
    }
  }

  return (
    <div className="space-y-3">
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
          <IntegrationList variant="grid">
            {filtered.map((provider) => {
              const pending = connecting === provider.slug
              return (
                <IntegrationRow
                  key={provider.slug}
                  boxed
                  iconSlug={provider.slug}
                  iconFallback="oauth"
                  name={<HighlightMatch text={provider.displayName} query={filter} />}
                  subtitle={provider.description}
                  right={
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => handleConnect(provider.slug)}
                      disabled={connecting !== null}
                      aria-label={`Connect ${provider.displayName}`}
                      data-testid={`directory-connect-api-${provider.slug}`}
                    >
                      {pending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Plus className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  }
                />
              )
            })}
            <div className="col-span-2 rounded-lg bg-muted/50 px-3 py-2.5 text-[11px] text-muted-foreground">
              Don&apos;t see the API you&apos;re looking for? Check MCPs or ask your agent about connecting to a specific service.
            </div>
          </IntegrationList>
        </div>
      )}
    </div>
  )
}

// --- MCPs panel ---

type DraftState = Omit<McpDraft, 'authType' | 'token' | 'clientName'> & {
  authType: McpAuthType
  token: string
  clientName: string
}

function McpsPanel({ filter, onAdded }: { filter: string; onAdded: () => void }) {
  const addMcp = useAddRemoteMcp()
  const initiateOAuth = useInitiateMcpOAuth()
  const invalidateRemoteMcps = useInvalidateRemoteMcps()

  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<DraftState | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [oauthPending, setOauthPending] = useState(false)

  useMcpOAuthListener(oauthPending, ({ success, error: oauthError }) => {
    setOauthPending(false)
    setSubmitting(false)
    if (success) {
      invalidateRemoteMcps()
      setDraft(null)
      onAdded()
    } else {
      setError(oauthError || 'OAuth authorization failed')
    }
  })

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

  const handlePickServer = (server: CommonMcpServer) => {
    setError(null)
    setDraft({
      sourceSlug: server.slug,
      name: server.displayName,
      url: server.url,
      authType: server.authType,
      token: '',
      clientName: '',
    })
  }

  const handlePickCustom = () => {
    setError(null)
    setDraft({ sourceSlug: 'custom', name: '', url: '', authType: 'none', token: '', clientName: '' })
  }

  const cancelDraft = () => {
    setDraft(null)
    setError(null)
  }

  const submitDraft = async () => {
    if (!draft) return
    setError(null)

    const parsed = mcpDraftSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Invalid MCP server details')
      return
    }
    const valid = parsed.data

    setSubmitting(true)
    try {
      if (valid.authType === 'oauth') {
        const popup = prepareOAuthPopup()
        try {
          const isElectron = !!window.electronAPI
          const clientNameOverride = valid.clientName.trim()
          const result = await initiateOAuth.mutateAsync({
            name: valid.name,
            url: valid.url,
            electron: isElectron,
            clientName: clientNameOverride.length > 0 ? clientNameOverride : undefined,
          })
          if (result.redirectUrl) {
            setOauthPending(true)
            await popup.navigate(result.redirectUrl)
            // Keep dialog open and spinner running until useMcpOAuthListener fires.
            return
          }
          popup.close()
          setDraft(null)
          onAdded()
        } catch (err) {
          popup.close()
          throw err
        }
      } else {
        await addMcp.mutateAsync({
          name: valid.name,
          url: valid.url,
          authType: valid.authType,
          accessToken: valid.authType === 'bearer' ? valid.token.trim() : undefined,
        })
        setDraft(null)
        onAdded()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add MCP server')
    } finally {
      // Only clear submitting if we're not waiting on OAuth — the listener
      // clears both states itself.
      if (!oauthPending) setSubmitting(false)
    }
  }

  const renderDraftBody = () => {
    if (!draft) return null
    const canSubmit = mcpDraftSchema.safeParse(draft).success
    const busy = submitting || oauthPending
    return (
      <div className="space-y-2">
        <div>
          <Label className="text-xs font-normal text-muted-foreground/70">Name</Label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="e.g., Granola Meetings"
            className="mt-1"
            data-testid="mcp-form-name"
          />
        </div>
        <div>
          <Label className="text-xs font-normal text-muted-foreground/70">Authentication</Label>
          <Select
            value={draft.authType}
            onValueChange={(v) => setDraft({ ...draft, authType: v as McpAuthType })}
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
        <div>
          <Label className="text-xs font-normal text-muted-foreground/70">URL</Label>
          <Input
            value={draft.url}
            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            placeholder="e.g., https://mcp.granola.ai/mcp"
            className="mt-1"
            data-testid="mcp-form-url"
          />
        </div>
        {draft.authType === 'bearer' && (
          <div>
            <Label className="text-xs font-normal text-muted-foreground/70">Access Token</Label>
            <Input
              type="password"
              value={draft.token}
              onChange={(e) => setDraft({ ...draft, token: e.target.value })}
              placeholder="Enter bearer token"
              className="mt-1"
              data-testid="mcp-form-token"
            />
          </div>
        )}
        {draft.authType === 'oauth' && (
          <details className="group rounded-md pt-2">
            <summary className="cursor-pointer list-none text-xs text-muted-foreground/70 hover:text-muted-foreground select-none">
              <span className="inline-block transition-transform group-open:rotate-90">›</span>
              <span className="ml-1">Advanced</span>
            </summary>
            <div className="mt-2">
              <Label className="text-xs font-normal text-muted-foreground/70">Client Name</Label>
              <Input
                value={draft.clientName}
                onChange={(e) => setDraft({ ...draft, clientName: e.target.value })}
                placeholder="Override OAuth client_name (optional)"
                className="mt-1"
                data-testid="mcp-form-client-name"
              />
            </div>
          </details>
        )}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Button size="sm" onClick={submitDraft} disabled={!canSubmit || busy} data-testid="mcp-form-submit">
            {busy ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                {oauthPending
                  ? 'Waiting for OAuth...'
                  : draft.authType === 'oauth' ? 'Connecting...' : 'Adding...'}
              </>
            ) : (
              <>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                Connect Server
              </>
            )}
          </Button>
        </div>
      </div>
    )
  }

  const renderMcpCard = (
    sourceSlug: string,
    iconSlug: string | undefined,
    iconFallback: 'mcp' | 'blocks',
    nameNode: ReactNode,
    subtitle: string,
    onOpen: () => void,
    ariaLabel: string,
  ) => {
    const isExpanded = draft?.sourceSlug === sourceSlug
    return (
      <div key={sourceSlug} className="rounded-lg border bg-background p-3 space-y-3">
        <div className="flex items-center gap-3">
          <div className="h-7 w-7 rounded-md bg-muted flex items-center justify-center shrink-0">
            <ServiceIcon slug={iconSlug} fallback={iconFallback} className="h-4 w-4 text-muted-foreground/60" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium truncate">{nameNode}</div>
            <div className="text-[11px] text-muted-foreground truncate">{subtitle}</div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7 shrink-0"
            onClick={isExpanded ? cancelDraft : onOpen}
            aria-label={isExpanded ? 'Cancel' : ariaLabel}
            data-testid={`directory-connect-mcp-${sourceSlug}`}
          >
            <Plus
              className={cn(
                'h-3.5 w-3.5 transition-transform duration-200',
                isExpanded && 'rotate-45'
              )}
            />
          </Button>
        </div>
        {isExpanded && renderDraftBody()}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {error && !draft && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
        <IntegrationList variant="grid">
          {renderMcpCard(
            'custom',
            undefined,
            'blocks',
            'Custom MCP',
            'Add any MCP server by URL',
            handlePickCustom,
            'Add a custom MCP server',
          )}
        </IntegrationList>
        {Object.keys(grouped).length === 0 ? (
          <p className="text-sm text-muted-foreground">No MCP servers match your search.</p>
        ) : (
          Object.entries(grouped).map(([category, servers]) => (
            <div key={category} className="space-y-1.5">
              <p className="text-[11px] uppercase tracking-wide font-medium text-muted-foreground px-1">
                {category}
              </p>
              <IntegrationList variant="grid">
                {servers.map((server) =>
                  renderMcpCard(
                    server.slug,
                    server.slug,
                    'mcp',
                    <HighlightMatch text={server.displayName} query={filter} />,
                    server.description,
                    () => handlePickServer(server),
                    `Connect ${server.displayName}`,
                  ),
                )}
              </IntegrationList>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
