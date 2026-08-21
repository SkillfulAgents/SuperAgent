import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { useChatIntegrations, useChatIntegrationAccess, type ChatIntegrationListItem } from '@renderer/hooks/use-chat-integrations'
import { deriveChatIntegrationState, formatProviderName } from '@shared/lib/chat-integrations/utils'
import { ChatIntegrationPill } from '@renderer/components/chat-integrations/chat-integration-pill'
import type { ChatProvider } from '@shared/lib/chat-integrations/config-schema'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { useAgent } from '@renderer/hooks/use-agents'
import { ServiceIcon } from '@renderer/components/ui/service-icon'
import { ChatIntegrationSetupDialog } from '@renderer/components/chat-integrations/chat-integration-setup-dialog'
import { useNavigate } from '@tanstack/react-router'
import { useUser } from '@renderer/context/user-context'
import { HomeCollapsible } from './home-collapsible'

interface HomeChatIntegrationsProps {
  agentSlug: string
  className?: string
}

// All three fall back to their brand SVG (public/service-icons/<slug>.svg).
const PROVIDER_TILES: Array<{ slug: ChatProvider; label: string }> = [
  { slug: 'telegram', label: 'Telegram' },
  { slug: 'slack', label: 'Slack' },
  { slug: 'imessage', label: 'iMessage' },
]

// Status dot + an owner-only "N pending" count, derived from the access list
// the app already polls. Lives in its own component so the access query (one per
// integration) obeys the rules of hooks inside the integration list.
function IntegrationNameBadges({ integration, showPending }: { integration: ChatIntegrationListItem; showPending: boolean }) {
  // Approval gating is Telegram-only (see chat-integration-access-service); other
  // providers always forward, so there are never pending requests to badge.
  const enabled = showPending && integration.provider === 'telegram' && !!integration.requireApproval
  const { data: access } = useChatIntegrationAccess(enabled ? integration.id : null)
  const pending = enabled ? (access?.filter((a) => a.status === 'pending').length ?? 0) : 0
  return (
    <span className="inline-flex items-center gap-1">
      <ChatIntegrationPill state={deriveChatIntegrationState(integration.status, integration.connected)} size="xs" />
      {pending > 0 && (
        <span className="text-2xs px-1.5 py-0 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">
          {pending} pending
        </span>
      )}
    </span>
  )
}

export function HomeChatIntegrations({ agentSlug, className }: HomeChatIntegrationsProps) {
  const { data: integrations } = useChatIntegrations(agentSlug)
  const navigate = useNavigate()
  const { canAdminAgent } = useUser()
  const canManageApproval = canAdminAgent(agentSlug)
  const { data: agent } = useAgent(agentSlug)
  const agentName = agent?.name ?? agentSlug
  const rows = Array.isArray(integrations) ? integrations : []
  const [setupProvider, setSetupProvider] = useState<ChatProvider | null>(null)

  return (
    <HomeCollapsible title="Remote Chat" className={className}>
      {rows.length > 0 ? (
        <div className="mt-2 divide-y divide-border/50">
          {rows.map((integration) => {
            // Fall back to the agent's name (matches the connector page title), not
            // "<Provider> Bot" - the provider already shows in the subtitle below.
            const displayName = integration.name || agentName
            return (
              <IntegrationRow
                key={integration.id}
                iconSlug={integration.provider}
                iconFallback="mcp"
                name={displayName}
                nameBadge={<IntegrationNameBadges integration={integration} showPending={canManageApproval} />}
                subtitle={
                  // formatProviderName already returns the correct display casing
                  // ("Telegram", "Slack", "iMessage"); a `capitalize` class would
                  // re-cap "iMessage" to "IMessage", so don't add one.
                  <span>{formatProviderName(integration.provider)}</span>
                }
                onActivate={() => {
                  void navigate({
                    to: '/agents/$slug/chat/$integrationId',
                    params: { slug: agentSlug, integrationId: integration.id },
                  })
                }}
              />
            )
          })}
        </div>
      ) : (
        <div className="mt-3 mx-4 rounded-lg border border-dashed p-4 text-muted-foreground">
          <p className="text-xs font-medium text-foreground">Not configured yet</p>
          <p className="text-xs mt-1">
            Connect messaging to chat with this agent from anywhere.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {PROVIDER_TILES.map((tile) => (
              <button
                key={tile.slug}
                onClick={() => setSetupProvider(tile.slug)}
                aria-label={`Chat via ${tile.label}`}
                className="flex items-center gap-2 rounded-lg border border-border bg-background p-2 shadow-sm transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-background dark:bg-zinc-200 shadow-sm">
                  <ServiceIcon slug={tile.slug} fallback="mcp" className="h-4 w-4" />
                </div>
                <div className="flex flex-col items-start">
                  <span className="text-2xs font-normal text-muted-foreground">Chat via</span>
                  <span className="text-xs font-normal text-foreground">{tile.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
      {rows.length > 0 && (
        <div className="flex items-center justify-between mt-1 px-4 pb-1">
          <div className="ml-auto">
            <Popover>
              <PopoverTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  <Plus /> Add Integration
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-1">
                {PROVIDER_TILES.map((tile) => (
                  <button
                    key={tile.slug}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-muted transition-colors"
                    onClick={() => setSetupProvider(tile.slug)}
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background dark:bg-zinc-200">
                      <ServiceIcon slug={tile.slug} fallback="mcp" className="h-3 w-3" />
                    </div>
                    {tile.label}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      )}
      <ChatIntegrationSetupDialog
        agentSlug={agentSlug}
        provider={setupProvider}
        onOpenChange={(open) => { if (!open) setSetupProvider(null) }}
      />
    </HomeCollapsible>
  )
}
