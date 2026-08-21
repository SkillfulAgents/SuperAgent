import { useMemo, useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { IntegrationList, IntegrationRow } from '@renderer/components/connections/integration-row'
import { DetailCard } from '@renderer/components/triggers/detail-card'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import type { SortOrder } from '@renderer/components/sessions/related-sessions'
import { SectionHeader } from '@renderer/components/ui/section-header'
import { useInboundXAgentDetails } from '@renderer/hooks/use-inbound-x-agent'

interface InboundXAgentViewProps {
  agentSlug: string
}

export function InboundXAgentView({ agentSlug }: InboundXAgentViewProps) {
  const navigate = useNavigate()
  const { data, isLoading, error } = useInboundXAgentDetails(agentSlug)
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')

  const sessions = useMemo(() => {
    const rows = [...(data?.sessions ?? [])]
    return sortOrder === 'newest' ? rows : rows.reverse()
  }, [data?.sessions, sortOrder])

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading calls from other agents...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="flex flex-1 items-center justify-center text-destructive">
        Failed to load calls from other agents
      </div>
    )
  }

  return (
    <SettingsPageContainer fullScreen>
      <PageTitle
        title="Called from Other Agents"
        back={{
          onClick: () => {
            void navigate({ to: '/agents/$slug', params: { slug: agentSlug } })
          },
          testId: 'inbound-x-agent-back-button',
        }}
      />

      <div className="grid grid-cols-1 gap-y-6 lg:grid-cols-[3fr_2fr] lg:gap-x-10 lg:gap-y-0">
        <section className="order-2 lg:order-1">
          <SectionHeader
            title="Run History"
            actions={sessions.length > 1 ? (
              <SortPopover value={sortOrder} onChange={setSortOrder} ariaLabel="Sort calls" />
            ) : undefined}
          />

          {sessions.length === 0 ? (
            <p className="py-6 text-xs text-muted-foreground">
              No calls from other agents yet.
            </p>
          ) : (
            <div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] gap-4 border-b px-2 py-2 text-[11px] font-medium text-muted-foreground">
                <span>Time</span>
                <span>Triggered by</span>
              </div>
              {sessions.map((session) => (
                <div
                  key={session.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Open call from ${session.triggeredBy.name}`}
                  className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_minmax(0,0.8fr)] items-center gap-4 border-b px-2 py-3 text-xs transition-colors hover:bg-muted/50"
                  onClick={() => {
                    void navigate({
                      to: '/agents/$slug/sessions/$sessionId',
                      params: { slug: agentSlug, sessionId: session.id },
                    })
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    void navigate({
                      to: '/agents/$slug/sessions/$sessionId',
                      params: { slug: agentSlug, sessionId: session.id },
                    })
                  }}
                >
                  <span>{new Date(session.createdAt).toLocaleString()}</span>
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate">{session.triggeredBy.name}</span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <div className="order-1 lg:order-2">
          <DetailCard label="Agents that can trigger this agent">
            {data.callers.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No other agents can currently trigger this agent.
              </p>
            ) : (
              <IntegrationList>
                {data.callers.map((caller) => (
                  <IntegrationRow
                    key={caller.slug}
                    icon={null}
                    name={caller.name}
                    subtitle={caller.canAccess
                      ? caller.decision === 'allow' ? 'Allowed' : 'Approval required'
                      : `${caller.decision === 'allow' ? 'Allowed' : 'Approval required'} · No access`}
                    disabled={!caller.canAccess}
                    ariaLabel={caller.canAccess
                      ? `Open ${caller.name}`
                      : `${caller.name}, you do not have access`}
                    onActivate={caller.canAccess ? () => {
                      void navigate({
                        to: '/agents/$slug',
                        params: { slug: caller.displaySlug },
                      })
                    } : undefined}
                    right={caller.canAccess ? (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : undefined}
                  />
                ))}
              </IntegrationList>
            )}
          </DetailCard>
        </div>
      </div>
    </SettingsPageContainer>
  )
}
