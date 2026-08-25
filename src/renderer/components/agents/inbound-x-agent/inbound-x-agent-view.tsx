import { useEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { AlertCircle, ChevronRight, Loader2 } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { SettingsPageContainer, PageTitle } from '@renderer/components/layout/settings-page'
import { IntegrationRow } from '@renderer/components/connections/integration-row'
import { SortPopover } from '@renderer/components/sessions/sort-popover'
import type { SortOrder } from '@renderer/components/sessions/related-sessions'
import { SectionHeader } from '@renderer/components/ui/section-header'
import { Switch } from '@renderer/components/ui/switch'
import { useUser } from '@renderer/context/user-context'
import { startViewTransition } from '@renderer/lib/view-transition'
import {
  useInboundXAgentDetails,
  useSetInboundXAgentPermission,
} from '@renderer/hooks/use-inbound-x-agent'
import type { InboundXAgentCaller } from '@shared/lib/types/inbound-x-agent-schema'

interface InboundXAgentViewProps {
  agentSlug: string
}

export function InboundXAgentView({ agentSlug }: InboundXAgentViewProps) {
  const navigate = useNavigate()
  const { data, isLoading, error } = useInboundXAgentDetails(agentSlug)
  const setPermission = useSetInboundXAgentPermission(agentSlug)
  const { isAuthMode, rolesReady, canAdminAgent } = useUser()
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [decisionOverrides, setDecisionOverrides] = useState<Record<string, 'allow' | 'review'>>({})
  const [pendingCallers, setPendingCallers] = useState<Set<string>>(() => new Set())
  const [permissionError, setPermissionError] = useState<string | null>(null)

  const sessions = useMemo(() => {
    const rows = [...(data?.sessions ?? [])]
    return sortOrder === 'newest' ? rows : rows.reverse()
  }, [data?.sessions, sortOrder])

  useEffect(() => {
    if (!data || Object.keys(decisionOverrides).length === 0) return
    const serverDecision = new Map(data.callers.map((caller) => [caller.slug, caller.decision]))
    setDecisionOverrides((previous) => {
      let changed = false
      const next = { ...previous }
      for (const [slug, decision] of Object.entries(previous)) {
        if (serverDecision.get(slug) === decision) {
          delete next[slug]
          changed = true
        }
      }
      return changed ? next : previous
    })
  }, [data, decisionOverrides])

  const effectiveDecision = (caller: InboundXAgentCaller): 'allow' | 'review' =>
    decisionOverrides[caller.slug] ?? caller.decision

  const animateOverride = (slug: string, decision: 'allow' | 'review' | null) => {
    startViewTransition(() => {
      flushSync(() => {
        setDecisionOverrides((previous) => {
          const next = { ...previous }
          if (decision === null) delete next[slug]
          else next[slug] = decision
          return next
        })
      })
    })
  }

  const handlePermissionToggle = async (caller: InboundXAgentCaller, checked: boolean) => {
    if (pendingCallers.has(caller.slug)) return
    const decision = checked ? 'allow' : 'review'
    setPermissionError(null)
    setPendingCallers((previous) => new Set(previous).add(caller.slug))
    animateOverride(caller.slug, decision)
    try {
      await setPermission.mutateAsync({ callerAgentSlug: caller.slug, decision })
    } catch (mutationError) {
      animateOverride(caller.slug, null)
      setPermissionError(
        mutationError instanceof Error ? mutationError.message : 'Failed to update caller permission',
      )
    } finally {
      setPendingCallers((previous) => {
        const next = new Set(previous)
        next.delete(caller.slug)
        return next
      })
    }
  }

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

  const automaticCallers = data.callers.filter((caller) => effectiveDecision(caller) === 'allow')
  const approvalCallers = data.callers.filter((caller) => effectiveDecision(caller) === 'review')

  const renderCallerRow = (caller: InboundXAgentCaller) => {
    const allowed = effectiveDecision(caller) === 'allow'
    const pending = pendingCallers.has(caller.slug)
    const canManage = caller.canAccess && (!isAuthMode || (rolesReady && canAdminAgent(caller.slug)))
    const accessNote = !caller.canAccess
      ? 'No access'
      : isAuthMode && !rolesReady
        ? 'Checking permissions…'
        : isAuthMode && !canAdminAgent(caller.slug)
          ? 'Owner access required'
          : null

    return (
      <IntegrationRow
        key={caller.slug}
        icon={null}
        name={caller.name}
        subtitle={(
          <span className="min-w-0 truncate font-mono">
            {caller.displaySlug}{accessNote ? ` · ${accessNote}` : ''}
          </span>
        )}
        viewTransitionName={`inbound-xagent-${caller.slug}`}
        right={(
          <>
            {pending && (
              <Loader2
                className="h-3.5 w-3.5 animate-spin text-muted-foreground"
                aria-label={`Saving permission for ${caller.name}`}
              />
            )}
            <Switch
              checked={allowed}
              disabled={!canManage || pending}
              onCheckedChange={(checked) => { void handlePermissionToggle(caller, checked) }}
              aria-label={`${allowed ? 'Require approval for' : 'Allow automatic'} calls from ${caller.name}`}
              data-testid={`inbound-x-agent-toggle-${caller.slug}`}
            />
          </>
        )}
      />
    )
  }

  const renderCallerSection = (
    label: string,
    callers: InboundXAgentCaller[],
    emptyMessage: string,
    testId: string,
  ) => (
    <section className="border-t" data-testid={testId}>
      <div className="border-b bg-muted/25 px-4 py-2">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </h4>
      </div>
      {callers.length > 0 ? (
        <div className="divide-y divide-border/50">
          {callers.map(renderCallerRow)}
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">{emptyMessage}</p>
      )}
    </section>
  )

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
          <div
            className="overflow-hidden rounded-xl border bg-background"
            data-testid="inbound-x-agent-callers-card"
          >
            <div className="px-4 py-4">
              <h3 className="text-sm font-medium text-muted-foreground">
                Agents that can trigger this agent
              </h3>
              {permissionError && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-destructive" role="alert">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {permissionError}
                </div>
              )}
            </div>
            {data.callers.length === 0 ? (
              <p className="border-t px-4 py-4 text-xs text-muted-foreground">
                No other agents can currently trigger this agent.
              </p>
            ) : (
              <>
                {renderCallerSection(
                  'Can automatically call',
                  automaticCallers,
                  'No agents can call automatically.',
                  'automatic-callers-section',
                )}
                {renderCallerSection(
                  'Require approval',
                  approvalCallers,
                  'No agents currently require approval.',
                  'approval-callers-section',
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </SettingsPageContainer>
  )
}
